const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const path = require("path");

app.use(express.static("public"));
app.use(express.json());

// --- DATABASE (In-Memory) ---
// In a real production app, this would be a database like MongoDB.
let wordDatabase = [
  { word: "Titanic", type: "Movie", difficulty: "Easy" },
  { word: "Inception", type: "Movie", difficulty: "Hard" },
  { word: "Frozen", type: "Movie", difficulty: "Easy" },
  { word: "Bohemian Rhapsody", type: "Song", difficulty: "Medium" },
  { word: "Thriller", type: "Song", difficulty: "Easy" },
  { word: "Rap God", type: "Song", difficulty: "Hard" },
  { word: "The Godfather", type: "Movie", difficulty: "Medium" },
  { word: "Shape of You", type: "Song", difficulty: "Easy" },
  { word: "Avatar", type: "Movie", difficulty: "Easy" },
  { word: "Pulp Fiction", type: "Movie", difficulty: "Medium" }
];

// Room State Storage
const rooms = {};

// --- ADMIN ROUTES ---
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  // Simple hardcoded credentials for demo
  if (username === "admin" && password === "charades123") {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

app.post("/admin/add-words", (req, res) => {
  const { type, difficulty, wordsRaw } = req.body;
  const newWords = wordsRaw.split(",").map(w => w.trim()).filter(w => w.length > 0);
  
  newWords.forEach(w => {
    wordDatabase.push({ word: w, type, difficulty });
  });
  
  console.log(`Added ${newWords.length} new words.`);
  res.json({ success: true, count: newWords.length });
});

// --- SOCKET GAME LOGIC ---
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // 1. Create Room (Game Lead)
  socket.on("create_room", (data) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    rooms[roomCode] = {
      config: data, // { roomName, gameType, teamCount, teamNames, duration }
      players: [],
      scores: {}, // { "Team A": 0, "Team B": 0 }
      currentTurn: null, // { player, team, word, startTime, difficulty }
      timer: null
    };

    // Initialize scores for teams
    data.teamNames.forEach(name => {
      rooms[roomCode].scores[name] = 0;
    });

    socket.emit("room_created", { roomCode, teamNames: data.teamNames });
  });

  // 2. Join Room (Player)
  socket.on("join_room", ({ roomCode, playerName, teamName }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("error_msg", "Room not found!");
      return;
    }

    socket.join(roomCode);
    
    const player = { id: socket.id, name: playerName, team: teamName };
    room.players.push(player);

    // Notify everyone in room (update lobby)
    io.to(roomCode).emit("update_lobby", {
      players: room.players,
      config: room.config,
      scores: room.scores
    });

    // Send current game state if game is in progress
    if (room.currentTurn && room.currentTurn.active) {
       socket.emit("game_in_progress", room.currentTurn);
    }
  });

  // 3. Player requests to take a turn
  socket.on("setup_turn", ({ roomCode }) => {
    // Only send the setup screen to the requestor
    socket.emit("show_turn_options");
  });

  // 4. Player confirms options (Movie/Hard) -> Get Word
  socket.on("get_word", ({ roomCode, type, difficulty }) => {
    const room = rooms[roomCode];
    if(!room) return;

    // Filter words
    const eligibleWords = wordDatabase.filter(w => 
      (type === "Both" || w.type === type) && 
      w.difficulty === difficulty
    );

    if (eligibleWords.length === 0) {
      socket.emit("error_msg", "No words found for these settings! Add more in Admin.");
      return;
    }

    const randomWord = eligibleWords[Math.floor(Math.random() * eligibleWords.length)];

    // Set Turn State
    room.currentTurn = {
      player: socket.id,
      wordObj: randomWord,
      type: type,
      difficulty: difficulty,
      active: false
    };

    // Tell everyone else "Gamer Ready"
    socket.broadcast.to(roomCode).emit("gamer_getting_ready");
    
    // Show the word ONLY to the actor
    socket.emit("receive_word", randomWord);
  });

  // 5. Start Acting (Timer Start)
  socket.on("start_acting", ({ roomCode }) => {
    const room = rooms[roomCode];
    if(!room || !room.currentTurn) return;

    room.currentTurn.active = true;
    room.currentTurn.startTime = Date.now();
    let duration = parseInt(room.config.duration);

    io.to(roomCode).emit("game_started", { duration });

    // Clear existing timer if any
    if (room.timer) clearInterval(room.timer);

    // Server-side timer to sync end
    room.timer = setInterval(() => {
      duration--;
      if (duration <= 0) {
        clearInterval(room.timer);
        io.to(roomCode).emit("turn_ended", { success: false });
        io.to(roomCode).emit("update_scores", room.scores); // Show leaderboard
      }
    }, 1000);
  });

  // 6. Word Found (Calculate Score)
  socket.on("word_found", ({ roomCode }) => {
    const room = rooms[roomCode];
    if(!room || !room.currentTurn) return;

    clearInterval(room.timer);

    // --- SCORING ALGORITHM ---
    const totalTime = parseInt(room.config.duration);
    const timeTaken = (Date.now() - room.currentTurn.startTime) / 1000;
    const timeRemaining = Math.max(0, totalTime - timeTaken);
    
    // Difficulty Base: Easy (60), Medium (80), Hard (100)
    let maxPoints = 60;
    if (room.currentTurn.difficulty === "Medium") maxPoints = 80;
    if (room.currentTurn.difficulty === "Hard") maxPoints = 100;

    // Time Bonus: You get full points if instant, half points if last second
    // Formula: MaxPoints * (0.5 + 0.5 * (TimeRemaining / TotalTime))
    const score = Math.round(maxPoints * (0.5 + (0.5 * (timeRemaining / totalTime))));

    // Find player's team and update score
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      room.scores[player.team] += score;
    }

    io.to(roomCode).emit("turn_ended", { 
      success: true, 
      score, 
      word: room.currentTurn.wordObj.word,
      team: player ? player.team : "Unknown"
    });
    
    io.to(roomCode).emit("update_scores", room.scores);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
