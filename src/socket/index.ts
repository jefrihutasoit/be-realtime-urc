import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { getLatest, type PollResult } from "../services/poller.js";
import type { MachineMonitoring, MachineOee } from "../types/oee.js";

/**
 * Socket.IO contract (keep in sync with the frontend):
 *   server → client  "oee:update"         MachineOee[]       every poll, to everyone
 *   server → client  "monitoring:update"  MachineMonitoring  every poll, to subscribers of that machine
 *   client → server  "monitoring:subscribe"   machineId
 *   client → server  "monitoring:unsubscribe" machineId
 */
interface ServerToClient {
  "oee:update": (data: MachineOee[]) => void;
  "monitoring:update": (data: MachineMonitoring) => void;
}

interface ClientToServer {
  "monitoring:subscribe": (machineId: string) => void;
  "monitoring:unsubscribe": (machineId: string) => void;
}

const room = (machineId: string) => `machine:${machineId}`;

export function createSocketServer(httpServer: HttpServer) {
  const io = new Server<ClientToServer, ServerToClient>(httpServer, {
    cors: { origin: env.corsOrigin },
  });

  io.on("connection", (socket) => {
    socket.emit("oee:update", getLatest().oee);

    socket.on("monitoring:subscribe", (machineId) => {
      if (typeof machineId !== "string") return;
      socket.join(room(machineId));
      const current = getLatest().monitoring.find((m) => m.machineId === machineId);
      if (current) socket.emit("monitoring:update", current);
    });

    socket.on("monitoring:unsubscribe", (machineId) => {
      if (typeof machineId === "string") socket.leave(room(machineId));
    });
  });

  return {
    io,
    broadcast({ oee, monitoring }: PollResult) {
      io.emit("oee:update", oee);
      for (const m of monitoring) io.to(room(m.machineId)).emit("monitoring:update", m);
    },
  };
}
