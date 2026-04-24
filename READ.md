# Triphammer Consulting — Meeting Processor

A web app that pulls meeting transcripts from Notion, generates internal notes and parent emails using Claude AI, and pushes results back to Notion.

## Setup

### Environment Variables (set in Render dashboard)
- NOTION_TOKEN — your Notion internal integration token
- CLAUDE_API_KEY — your Anthropic Claude API key

### Deploy to Render
1. Push this repo to GitHub
2. Create a new Web Service on render.com
3. Connect your GitHub repo
4. Set environment variables
5. Deploy

Render will automatically run npm install and npm start.
