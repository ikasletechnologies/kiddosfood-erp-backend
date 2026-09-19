import { Server as SocketIOServer } from 'socket.io';
import { Server as HttpServer } from 'http';

class SocketService {
  private _io: SocketIOServer | null = null;

  public init(httpServer: HttpServer) {
    this._io = new SocketIOServer(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] }
    });

    this._io.on('connection', (socket) => {
      console.log(`🔌 Client connected to Real-time system: ${socket.id}`);

      socket.on('join', (data: any) => {
        if (data?.room) {
          socket.join(data.room);
          console.log(`🔌 Socket ${socket.id} joined room: ${data.room}`);
        }
      });
      
      socket.on('disconnect', () => {
         console.log(`🔌 Client disconnected: ${socket.id}`);
      });
    });
  }

  public get io() {
    if (!this._io) {
      throw new Error("Socket.io has not been initialized. Please call init() first.");
    }
    return this._io;
  }
}

export default new SocketService();
