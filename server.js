const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Triphammer Consulting — Meeting Processor App

// ── NOTION PROXY ──────────────────────────────────────────────
app.all('/api/notion/*', async (req, res) => {
  const notionPath = req.path.replace('/api/notion', '');
  const url = `https://api.notion.com${notionPath}`;
  try {
    const opts = {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      }
    };
    if (req.method !== 'GET' && req.body && Object.keys(req.body).length > 0) {
      opts.body = JSON.stringify(req.body);
    }
    const queryString = Object.keys(req.query).length
      ? '?' + new URLSearchParams(req.query).toString()
      : '';
    const notionRes = await fetch(url + queryString, opts);
    const data = await notionRes.json();
    res.status(notionRes.status).json(data);
  } catch (err) {
    console.error('Notion proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CLAUDE PROXY ──────────────────────────────────────────────
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
   - Plain text ONLY — no markdown, no asterisks, no pound signs, no bold
   - Use • for bullet points
   - Use ALL CAPS for section headers followed by a blank line
   - Conversational but professional tone
   - Formatted for direct Gmail copy-paste

Respond in EXACTLY this format with no extra text before or after:
===NOTE===
[internal note content]
===EMAIL===
[parent email content]`;

  const userMessage = `Meeting title: ${meetingTitle}\n\nTranscript:\n${transcript}`;
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
        messages: [{ role: 'user', content: userMessage }]
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

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', notion: !!NOTION_TOKEN, claude: !!CLAUDE_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Triphammer Meeting Processor running on port ${PORT}`);
});
