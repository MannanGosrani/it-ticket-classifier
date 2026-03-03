export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { title, description, systemPrompt } = req.body;

    if (!title || !description || !systemPrompt) {
      return res.status(400).json({ error: 'Missing required fields', received: { title: !!title, description: !!description, systemPrompt: !!systemPrompt } });
    }

    // Check if API key exists
    const apiKey = process.env.VITE_ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    console.log('Making request to Anthropic API...');

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Classify this support case:\n\nTITLE: ${title}\n\nDESCRIPTION: ${description}`
          }
        ],
      }),
    });

    const responseText = await anthropicResponse.text();
    console.log('Anthropic API status:', anthropicResponse.status);
    console.log('Anthropic API response:', responseText);

    if (!anthropicResponse.ok) {
      return res.status(anthropicResponse.status).json({ 
        error: 'Anthropic API error',
        status: anthropicResponse.status,
        details: responseText
      });
    }

    const data = JSON.parse(responseText);
    return res.status(200).json(data);

  } catch (error) {
    console.error('Error in classify function:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      stack: error.stack
    });
  }
}