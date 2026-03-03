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
      return res.status(400).json({ 
        error: 'Missing required fields', 
        received: { title: !!title, description: !!description, systemPrompt: !!systemPrompt } 
      });
    }

    // Azure OpenAI credentials from environment variables
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!apiKey || !endpoint || !deploymentName) {
      return res.status(500).json({ 
        error: 'Azure OpenAI not configured',
        missing: {
          apiKey: !apiKey,
          endpoint: !endpoint,
          deployment: !deploymentName
        }
      });
    }

    // Construct Azure OpenAI URL
    // Using the API version from your credentials: 2024-02-01
    const azureUrl = `${endpoint}/openai/deployments/${deploymentName}/chat/completions?api-version=2024-02-01`;

    console.log('Making request to Azure OpenAI...');

    const azureResponse = await fetch(azureUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: `Classify this support case:\n\nTITLE: ${title}\n\nDESCRIPTION: ${description}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: "json_object" }
      }),
    });

    const responseText = await azureResponse.text();
    console.log('Azure OpenAI status:', azureResponse.status);

    if (!azureResponse.ok) {
      console.error('Azure OpenAI error:', responseText);
      return res.status(azureResponse.status).json({ 
        error: 'Azure OpenAI API error',
        status: azureResponse.status,
        details: responseText
      });
    }

    const data = JSON.parse(responseText);
    
    // Extract the content from Azure OpenAI response format
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      return res.status(500).json({ 
        error: 'Invalid response from Azure OpenAI',
        response: data
      });
    }

    // Return in Anthropic-compatible format for frontend
    return res.status(200).json({
      content: [
        {
          type: "text",
          text: content
        }
      ]
    });

  } catch (error) {
    console.error('Error in classify function:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      stack: error.stack
    });
  }
}