import OpenAI from 'openai';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Remove Edge runtime config
// export const config = {
//   runtime: 'edge',
//   regions: ['iad1']
// };

export default async function handler(request: VercelRequest, response: VercelResponse) {
  console.log('API Route Handler Started');

  // Enable CORS
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }

  if (request.method !== 'POST') {
    response.status(405).json({ 
      error: 'Method not allowed',
      details: `Method ${request.method} is not supported`
    });
    return;
  }

  try {
    console.log('==== DEBUG START ====');
    console.log('Parsing request body...');
    const requestBody = request.body;
    console.log('Raw request body:', JSON.stringify(requestBody, null, 2));
    
    // Force stream to be true
    const { messages, context, apiKey } = requestBody;
    const stream = true; // Force streaming mode
    console.log('Stream parameter forced to:', stream);
    
    if (!apiKey) {
      console.log('No API key provided');
      response.status(401).json({ 
        error: 'OpenAI API key is required',
        details: 'API key was not provided in the request'
      });
      return;
    }

    // Check if request is about financial calculations to optimize handling
    const isFinancialCalculation = messages.some(msg => 
      msg.role === 'user' && 
      (msg.content.toLowerCase().includes('calculate') || 
       msg.content.toLowerCase().includes('income') ||
       msg.content.toLowerCase().includes('expenses') ||
       msg.content.toLowerCase().includes('tax'))
    );

    console.log('Request type:', isFinancialCalculation ? 'Financial calculation' : 'General inquiry');
    console.log('Streaming:', stream ? 'enabled' : 'disabled');
    console.log('==== DEBUG END ====');

    console.log('Initializing OpenAI client...');
    const openai = new OpenAI({
      apiKey: apiKey,
      baseURL: 'https://api.openai.com/v1',
      defaultHeaders: {
        'Content-Type': 'application/json',
      },
    });

    // Construct system message
    const systemMessage = {
      role: 'system',
      content: `You are a helpful assistant specialized in travel nurse contracts. You are provided with the CURRENT contract data in each new conversation - this is the ONLY valid contract data you should reference.

CRITICAL RULES:
1. ONLY use the contract data provided in THIS conversation. Disregard any contract information from previous conversations.
2. DO NOT reference historical data about contracts that is not included in the current dataset.
3. The contracts array provided in THIS conversation contains the ONLY currently valid contracts.
4. When a user mentions a contract that's not in the current dataset, inform them it's not available and ONLY suggest contracts from the current dataset.
5. If contract names have changed (e.g., a facility was renamed), only acknowledge the CURRENT names in the dataset.
6. IGNORE any previous contract information and ONLY use the data provided in this conversation.

For user preferences (like location preferences, pay requirements, name, etc):
- DO maintain these across conversations
- DO use these to personalize recommendations
- DO NOT use past contract knowledge, only current contracts

${isFinancialCalculation ? `
For financial calculations:
- Make calculations step by step
- Show your work clearly
- Base all calculations ONLY on data from the current contracts
- For tax estimates, use a standard 30% rate for taxable income unless user specifies otherwise
- Be precise with all numerical values and include proper units ($, weeks, etc.)
` : ''}

Always format your responses using Markdown for better readability. Use:
- Headers (#, ##, ###) for section titles
- Bullet points (-) for lists
- Bold text (**) for important information
- Italics (*) for emphasis
- Code blocks (\`\`\`) for numerical data or calculations
- Tables for comparing multiple contracts

Keep responses concise but informative.`
    };

    // Add context message with current contract data
    const contractDataMessage = {
      role: 'system',
      content: `CURRENT CONTRACT DATA (${new Date().toISOString()}): The following represents ALL current contracts (${context.totalContracts} total). ONLY reference these contracts and IGNORE any contract knowledge from previous conversations: ${JSON.stringify(context.contracts)}`
    };

    // Create filtered messages array without any system messages from the client
    const filteredMessages = messages.filter(msg => msg.role !== 'system');

    // Set appropriate parameters based on request type
    const temperature = isFinancialCalculation ? 0.3 : 0.7; // Lower temperature for more deterministic financial calculations
    const maxTokens = isFinancialCalculation ? 1500 : 1000; // Allow more tokens for financial calculations

    console.log('Sending request to OpenAI...');
    console.log('Request parameters:', { 
      isFinancialCalculation, 
      temperature, 
      maxTokens,
      messageCount: filteredMessages.length,
      streaming: stream
    });

    if (stream) {
      console.log('USING STREAMING MODE - Setting headers for streaming response');
      // Set headers for streaming response
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      
      // Send initial event to start the stream
      console.log('Sending initial event');
      response.write('data: {"type":"start"}\n\n');
      
      // Create the streaming completion
      console.log('Creating streaming completion with OpenAI');
      const streamCompletion = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [systemMessage, contractDataMessage, ...filteredMessages],
        temperature: temperature,
        max_tokens: maxTokens,
        stream: true,
      });
      
      let fullContent = '';
      let chunkCount = 0;
      
      // Stream the response chunks
      console.log('Processing stream chunks');
      for await (const chunk of streamCompletion) {
        if (chunk.choices[0]?.delta?.content) {
          const content = chunk.choices[0].delta.content;
          fullContent += content;
          chunkCount++;
          
          // Send the chunk as a server-sent event
          const eventData = JSON.stringify({ type: "chunk", content });
          console.log(`Sending chunk #${chunkCount}: length=${content.length} chars`);
          response.write(`data: ${eventData}\n\n`);
        }
      }
      
      // Send final event to indicate completion
      console.log(`Sending final event with ${fullContent.length} chars total content`);
      response.write(`data: ${JSON.stringify({ type: "end", content: fullContent })}\n\n`);
      response.end();
      
      console.log('Streaming response completed successfully');
    } else {
      // Non-streaming response (fallback)
      console.log('Using regular JSON response');
      const completion = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [systemMessage, contractDataMessage, ...filteredMessages],
        temperature: temperature,
        max_tokens: maxTokens,
      });

      console.log('Received response from OpenAI');
      const responseContent = completion.choices[0].message.content;
      
      response.status(200).json({ content: responseContent });
    }
  } catch (error) {
    console.error('Error in chat handler:', error);
    
    // Check for timeout error
    const isTimeoutError = error instanceof Error && 
      (error.message.includes('timeout') || error.message.includes('ETIMEDOUT') || error.message.includes('ESOCKETTIMEDOUT'));
    
    // Ensure we return a properly formatted error response
    response.status(isTimeoutError ? 504 : 500).json({ 
      error: isTimeoutError ? 'Request timed out' : 'Failed to process chat request',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
      timestamp: new Date().toISOString(),
      suggestion: isTimeoutError ? 'Try breaking your request into smaller, more specific questions' : undefined
    });
  }
} 