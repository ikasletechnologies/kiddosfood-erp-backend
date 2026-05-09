import 'dotenv/config';
import app from './app';
import { createServer } from 'http';
import SocketService from './lib/socket';

const PORT = process.env.PORT || 5000;

// Wrap Express with Node HTTP Server for Socket.io
const httpServer = createServer(app);

// Initialize WebSockets
SocketService.init(httpServer);

// Restarting server to pick up controller changes
httpServer.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);//
  console.log(`🔌 WebSocket server active`);
});

