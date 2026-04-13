import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Code, LogOut } from "lucide-react";
import { useState } from "react";

export default function Home() {
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth();
  const [roomIdToJoin, setRoomIdToJoin] = useState("");

  const handleCreateRoom = () => {
    const id = Math.random().toString(36).substring(2, 8);
    navigate(`/room/${id}`);
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (roomIdToJoin.trim()) {
      navigate(`/room/${roomIdToJoin.trim()}`);
    }
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <div className="home-container">
      <nav className="navbar glassmorphism-nav">
        <div className="logo-section">
          <Code size={24} color="var(--primary)" />
          <span className="logo-text">CollabCompile</span>
        </div>
        <div className="user-section">
          <span className="welcome-text">Hi, {currentUser.name}</span>
          <button onClick={handleLogout} className="icon-btn">
            <LogOut size={20} />
          </button>
        </div>
      </nav>

      <main className="main-content">
        <div className="hero-section text-center">
          <h1 className="gradient-text">Code Together, Anywhere.</h1>
          <p className="subtitle">
            Experience real-time collaborative editing with premium IDE features.
            Share your room link and start coding instantly.
          </p>
          <div className="action-buttons">
            <button onClick={handleCreateRoom} className="primary-btn glow-effect">
              Start New Session
            </button>
          </div>
          
          <div style={{ marginTop: "2.5rem" }}>
            <p className="subtitle" style={{ fontSize: "1rem", marginBottom: "1rem" }}>Or join an existing session</p>
            <form onSubmit={handleJoinRoom} style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
              <input 
                type="text" 
                placeholder="Enter Room ID" 
                value={roomIdToJoin}
                onChange={(e) => setRoomIdToJoin(e.target.value)}
                style={{
                  padding: "0.75rem 1rem",
                  background: "rgba(15, 23, 42, 0.6)",
                  border: "1px solid rgba(255, 255, 255, 0.1)",
                  borderRadius: "8px",
                  color: "var(--text-main)",
                  fontFamily: "inherit",
                  outline: "none"
                }}
              />
              <button 
                type="submit" 
                disabled={!roomIdToJoin.trim()}
                style={{
                  background: roomIdToJoin.trim() ? "var(--primary)" : "rgba(255,255,255,0.1)",
                  color: "white",
                  border: "none",
                  padding: "0.75rem 1.5rem",
                  borderRadius: "8px",
                  cursor: roomIdToJoin.trim() ? "pointer" : "not-allowed",
                  fontWeight: "600",
                  transition: "background 0.2s"
                }}
              >
                Join
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
