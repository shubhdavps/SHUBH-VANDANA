const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /mp4|mkv|avi|mov|webm/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Store active rooms and users
const rooms = new Map();
const users = new Map();

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// File upload endpoint
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    success: true,
    fileUrl: fileUrl,
    fileName: req.file.originalname,
    fileSize: req.file.size
  });
});

// Get list of uploaded videos
app.get('/api/videos', (req, res) => {
  fs.readdir('uploads', (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Unable to read uploads directory' });
    }

    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext);
    });

    res.json({ videos: videoFiles });
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User joins a room
  socket.on('join-room', (data) => {
    const { roomId, username } = data;
    
    socket.join(roomId);
    users.set(socket.id, { roomId, username });
    
    // Initialize room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: new Set(),
        currentVideo: null,
        videoType: null, // 'upload' or 'youtube'
        playbackState: {
          isPlaying: false,
          currentTime: 0,
          playbackRate: 1
        }
      });
    }

    const room = rooms.get(roomId);
    room.users.add(socket.id);

    // Notify other users in the room
    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      username: username
    });

    // Send current room state to the new user
    socket.emit('room-state', {
      video: room.currentVideo,
      videoType: room.videoType,
      playbackState: room.playbackState,
      users: Array.from(room.users).map(userId => ({
        userId: userId,
        username: users.get(userId)?.username || 'Unknown'
      }))
    });

    console.log(`User ${username} joined room ${roomId}`);
  });

  // Handle video sync events
  socket.on('video-event', (data) => {
    const user = users.get(socket.id);
    if (!user || !rooms.has(user.roomId)) return;

    const room = rooms.get(user.roomId);
    
    // Update room state
    if (data.type === 'play') {
      room.playbackState.isPlaying = true;
      room.playbackState.currentTime = data.currentTime || 0;
    } else if (data.type === 'pause') {
      room.playbackState.isPlaying = false;
      room.playbackState.currentTime = data.currentTime || 0;
    } else if (data.type === 'seek') {
      room.playbackState.currentTime = data.currentTime || 0;
    } else if (data.type === 'rate-change') {
      room.playbackState.playbackRate = data.playbackRate || 1;
    }

    // Broadcast to other users in the room
    socket.to(user.roomId).emit('video-event', data);
  });

  // Handle YouTube video change
  socket.on('change-youtube-video', (data) => {
    const user = users.get(socket.id);
    if (!user || !rooms.has(user.roomId)) return;

    const room = rooms.get(user.roomId);
    room.currentVideo = data.videoId;
    room.videoType = 'youtube';
    room.playbackState = {
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1
    };

    // Broadcast to all users in the room
    io.to(user.roomId).emit('youtube-video-changed', {
      videoId: data.videoId,
      title: data.title
    });
  });

  // Handle uploaded video change
  socket.on('change-uploaded-video', (data) => {
    const user = users.get(socket.id);
    if (!user || !rooms.has(user.roomId)) return;

    const room = rooms.get(user.roomId);
    room.currentVideo = data.fileUrl;
    room.videoType = 'upload';
    room.playbackState = {
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1
    };

    // Broadcast to all users in the room
    io.to(user.roomId).emit('uploaded-video-changed', {
      fileUrl: data.fileUrl,
      fileName: data.fileName
    });
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    const messageData = {
      userId: socket.id,
      username: user.username,
      message: data.message,
      timestamp: new Date().toISOString()
    };

    // Broadcast to all users in the room
    io.to(user.roomId).emit('chat-message', messageData);
  });

  // WebRTC signaling
  socket.on('webrtc-offer', (data) => {
    socket.to(data.target).emit('webrtc-offer', {
      offer: data.offer,
      from: socket.id
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.target).emit('webrtc-answer', {
      answer: data.answer,
      from: socket.id
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(data.target).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      from: socket.id
    });
  });

  // Handle user disconnect
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      const room = rooms.get(user.roomId);
      if (room) {
        room.users.delete(socket.id);
        
        // If room is empty, clean it up
        if (room.users.size === 0) {
          rooms.delete(user.roomId);
        } else {
          // Notify other users
          socket.to(user.roomId).emit('user-left', {
            userId: socket.id,
            username: user.username
          });
        }
      }
      
      users.delete(socket.id);
    }
    
    console.log('User disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 200MB.' });
    }
  }
  res.status(500).json({ error: error.message });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
