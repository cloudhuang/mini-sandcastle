import { piAgent } from './src/agents/pi.ts';

const agent = piAgent();

const line = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "<plan>{\"issues\":[]}</plan>" }]
  }
});

const obj = JSON.parse(line);
console.log('obj.type:', obj.type);
console.log('obj.message?.content:', obj.message?.content);
console.log('Array.isArray:', Array.isArray(obj.message?.content));

const events = agent.parseStreamLine(line);
console.log('Events:', JSON.stringify(events, null, 2));
