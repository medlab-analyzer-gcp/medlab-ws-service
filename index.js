/**
 * WebSocket Service
 *
 * Listens to Firestore onSnapshot for report status changes
 * Pushes real-time notifications to connected clients via Socket.io
 *
 * Flow:
 * 1. Client connects via WebSocket and sends their userId
 * 2. Service opens Firestore onSnapshot for that userId's reports
 * 3. When analysis-service updates report status to "analyzed"
 * 4. Firestore triggers onSnapshot
 * 5. This service pushes "analysis-done" event to the client
 */

const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { Firestore } = require("@google-cloud/firestore");
const logger = require("./src/utils/logger");

// ==============================================================================
// Configuration
// ==============================================================================

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.PROJECT_ID;

if (!PROJECT_ID) {
  logger.error("Missing required environment variable: PROJECT_ID");
  process.exit(1);
}

// ==============================================================================
// Initialize
// ==============================================================================

const app = express();
const httpServer = createServer(app);
const firestore = new Firestore({ projectId: PROJECT_ID });

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  // Important: allow WebSocket + HTTP long-polling fallback
  transports: ["websocket", "polling"],
});

// ==============================================================================
// Health Check
// ==============================================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "ws-service",
    connections: io.engine.clientsCount,
  });
});

// ==============================================================================
// WebSocket Connections
// ==============================================================================

io.on("connection", (socket) => {
  logger.info("Client connected", { socketId: socket.id });

  let firestoreUnsubscribe = null;

  // Client sends userId to subscribe to their reports
  socket.on("subscribe", (userId) => {
    if (!userId) {
      socket.emit("error", { message: "userId is required" });
      return;
    }

    logger.info("Client subscribing to reports", {
      socketId: socket.id,
      userId,
    });

    // Clean up previous listener if any
    if (firestoreUnsubscribe) {
      firestoreUnsubscribe();
    }

    let initialSnapshotReceived = false;

    // Open Firestore onSnapshot — watches this user's reports.
    // "subscribed" is emitted only after the first snapshot callback fires,
    // which confirms the gRPC stream is fully established. This prevents the
    // race condition where the browser calls analyzeRequest before Firestore
    // is actually listening, causing the status change to arrive as type
    // "added" (initial snapshot) instead of "modified" (incremental update).
    firestoreUnsubscribe = firestore
      .collection("reports")
      .where("userId", "==", userId)
      .onSnapshot(
        (snapshot) => {
          if (!initialSnapshotReceived) {
            initialSnapshotReceived = true;
            socket.emit("subscribed", { userId, message: "Listening for updates" });
            logger.info("Firestore stream ready, subscribed", { socketId: socket.id, userId });
          }

          snapshot.docChanges().forEach((change) => {
            if (change.type === "modified") {
              const data = change.doc.data();

              if (data.status === "analyzed") {
                logger.info("Analysis done — pushing to client", {
                  socketId: socket.id,
                  reportId: change.doc.id,
                });

                socket.emit("analysis-done", {
                  reportId: change.doc.id,
                  status: data.status,
                  analysisId: data.analysisId,
                  fileName: data.fileName,
                });
              }
            }
          });
        },
        (error) => {
          logger.error("Firestore onSnapshot error", { error: error.message });
          socket.emit("error", { message: "Real-time listener failed" });
        }
      );
  });

  // Clean up Firestore listener on disconnect
  socket.on("disconnect", () => {
    logger.info("Client disconnected", { socketId: socket.id });
    if (firestoreUnsubscribe) {
      firestoreUnsubscribe();
    }
  });
});

// ==============================================================================
// Graceful Shutdown
// ==============================================================================

const server = httpServer.listen(PORT, () => {
  logger.info(`WS Service listening on port ${PORT}`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received — shutting down");
  server.close(() => {
    process.exit(0);
  });
});
