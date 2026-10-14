import 'dotenv/config';
import app from './app';
import { createServer } from 'http';
import SocketService from './lib/socket';
import { initChatSocket } from './modules/chat/chat.socket';

const PORT = process.env.PORT || 5000;

// Wrap Express with Node HTTP Server for Socket.io
const httpServer = createServer(app);

// Initialize WebSockets
SocketService.init(httpServer);
// Authenticated /chat namespace (Super Admin ⇄ Franchise chat)
initChatSocket(SocketService.io);

// Restarting server to pick up controller changes //
httpServer.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT} (Reloaded)`);
  console.log(`🔌 WebSocket server active`);
});
// Reload trigger: 2026-10-11T11:55:00

