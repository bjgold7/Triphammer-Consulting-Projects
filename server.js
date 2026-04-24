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

// ── MEETINGS LIST — queries your specific Meeting Notes & Chat Logs database
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

// ── PAGE CONTENT — fetches blocks from a specific page
app.get('/api/page/:pageId', async (req, res) => {
  try {
    const response = await fetch(`https://api.notion.com/v1/blocks/${req.params.pageId}/children?page_size=100`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Notion error');
    res.json(data);
  } catch (err) {
    console.error('Page content error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUSH NOTE TO NOTION — appends internal note to a page
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

// ── CLAUDE — generates internal note + parent email from transcript
app.post('/api/claude', async (req, res) => {
  const { transcript, meetingTitle } = req.body;
  if (!transcript || transcript.length < 30) {
    return res.status(400).json({ error: 'Transcript is empty or too short. Please paste the transcript into the Notion page first.' });
  }

  const systemPrompt = `You are an expert college admissions consultant's assistant for Triphammer Consulting, run by Brent Goldman (formerly 20+ years in finance, now college counseling with Emily).

Generate two outputs from meeting transcripts:

1. INTERNAL NOTE: A structured, detailed note for Brent's records. Include sections for:
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

Respond in EXACTLY this format with no extra text before or after:
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Meeting title: ${meetingTitle}\n\nTranscript:\n${transcript}` }]
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
