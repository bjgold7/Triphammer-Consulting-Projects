const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const MEETINGS_DB_ID = 'd53b4292-935a-4b7b-bcbb-6052423d786c';

// Triphammer Consulting — Meeting Processor

// ── MEETINGS LIST
app.get('/api/meetings', async (req, res) => {
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${MEETINGS_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        page_size: 50
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Notion error');
    res.json(data);
  } catch (err) {
    console.error('Meetings fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PAGE CONTENT — reads EVERYTHING: properties + body blocks
app.get('/api/page/:pageId', async (req, res) => {
  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${req.params.pageId}`, {
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }
    });
    const pageData = await pageRes.json();

    const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${req.params.pageId}/children?page_size=100`, {
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }
    });
    const blocksData = await blocksRes.json();

    let content = '';
    const props = pageData.properties || {};

    for (const [key, prop] of Object.entries(props)) {
      let value = '';
      if (prop.type === 'title' && prop.title?.length > 0) {
        value = prop.title.map(t => t.plain_text).join('');
      } else if (prop.type === 'rich_text' && prop.rich_text?.length > 0) {
        value = prop.rich_text.map(t => t.plain_text).join('');
      } else if (prop.type === 'date' && prop.date?.start) {
        value = prop.date.start;
      } else if (prop.type === 'select' && prop.select?.name) {
        value = prop.select.name;
      } else if (prop.type === 'multi_select' && prop.multi_select?.length > 0) {
        value = prop.multi_select.map(s => s.name).join(', ');
      } else if (prop.type === 'number' && prop.number !== null) {
        value = String(prop.number);
      } else if (prop.type === 'checkbox') {
        value = prop.checkbox ? 'Yes' : 'No';
      } else if (prop.type === 'url' && prop.url) {
        value = prop.url;
      } else if (prop.type === 'email' && prop.email) {
        value = prop.email;
      } else if (prop.type === 'phone_number' && prop.phone_number) {
        value = prop.phone_number;
      }
      if (value && value.trim().length > 0) {
        content += `[${key}]: ${value}\n`;
      }
    }

    const blocks = blocksData.results || [];
    if (blocks.length > 0) {
      content += '\n[Meeting Notes / Transcript]\n';
      for (const b of blocks) {
        const t = b.type;
        const bd = b[t];
        if (!bd) continue;
        let line = '';
        if (bd.rich_text) line = bd.rich_text.map(x => x.plain_text).join('');
        if (!line.trim()) continue;
        if (t === 'heading_1') content += `\n# ${line}\n`;
        else if (t === 'heading_2') content += `\n## ${line}\n`;
        else if (t === 'heading_3') content += `\n### ${line}\n`;
        else if (t === 'bulleted_list_item') content += `• ${line}\n`;
        else if (t === 'numbered_list_item') content += `${line}\n`;
        else if (t === 'quote') content += `> ${line}\n`;
        else if (t === 'callout') content += `[Note] ${line}\n`;
        else content += `${line}\n`;
      }
    }

    res.json({ content: content.trim(), title: getPageTitle(pageData) });

  } catch (err) {
    console.error('Page content error:', err);
    res.status(500).json({ error: err.message });
  }
});

function getPageTitle(pageData) {
  try {
    for (const prop of Object.values(pageData.properties || {})) {
      if (prop.type === 'title' && prop.title?.length > 0) {
        return prop.title.map(t => t.plain_text).join('');
      }
    }
    return 'Untitled';
  } catch { return 'Untitled'; }
}

// ── PUSH NOTE TO NOTION
app.post('/api/push/:pageId', async (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'No note content provided' });
  try {
    const lines = note.split('\n').filter(l => l.trim());
    const children = [
      { object: 'block', type: 'divider', divider: {} },
      {
        object: 'block', type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: `Internal Note — ${new Date().toLocaleDateString()}` } }] }
      },
      ...lines.map(l => ({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: l.substring(0, 2000) } }] }
      }))
    ];
    const response = await fetch(`https://api.notion.com/v1/blocks/${req.params.pageId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ children })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Push failed');
    res.json({ success: true });
  } catch (err) {
    console.error('Push to Notion error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CLAUDE — generates internal note + parent email from ALL page content
app.post('/api/claude', async (req, res) => {
  const { content, meetingTitle } = req.body;
  if (!content || content.length < 30) {
    return res.status(400).json({ error: 'This page appears to be empty. Please make sure meeting notes or a transcript are saved in Notion first.' });
  }

  const systemPrompt = `You are an expert college admissions consultant's assistant for Triphammer Consulting, run by Brent Goldman (formerly 20+ years in finance, now college counseling with Emily).

You will receive ALL content from a Notion meeting page — this may include database property fields (like Otter Summary, Meeting Transcript, Notes, AI Summary), freeform typed notes, and any other content Brent has added. Some fields may be empty. Use everything available to produce the best possible outputs.

Generate two outputs:

1. INTERNAL NOTE: A structured, detailed note for Brent's records. Synthesize ALL available information. Include:
   - Student Profile (name, grade, school, key stats)
   - Academics (GPA, courses, testing)
   - Athletics (if relevant)
   - Activities & Interests
   - Family Dynamics (parent names, concerns, communication style)
   - Strategic Notes (college list thinking, recruiting path, essay angles)
   - Action Items (who does what, by when)

2. PARENT EMAIL: A warm, professional follow-up email from Brent to the family.
   - Plain text ONLY — no markdown, no asterisks, no pound signs
   - Use • for bullet points
   - Use ALL CAPS for section headers followed by a blank line
   - Conversational but professional tone
   - Formatted for direct Gmail copy-paste

Respond in EXACTLY this format:
===NOTE===
[internal note content]
===EMAIL===
[parent email content]`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5-20251101',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Meeting: ${meetingTitle}\n\n${content}` }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json();
      return res.status(claudeRes.status).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await claudeRes.json();
    const fullText = data.content[0].text;
    const noteMatch = fullText.match(/===NOTE===([\s\S]*?)===EMAIL===/);
    const emailMatch = fullText.match(/===EMAIL===([\s\S]*)$/);

    res.json({
      note: noteMatch ? noteMatch[1].trim() : fullText,
      email: emailMatch ? emailMatch[1].trim() : ''
    });
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', notion: !!NOTION_TOKEN, claude: !!CLAUDE_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Triphammer Meeting Processor running on port ${PORT}`);
});
