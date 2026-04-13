import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import * as awarenessProtocol from "y-protocols/awareness";
import { io } from "socket.io-client";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { LogOut, Link as LinkIcon, Check, Play } from "lucide-react";
import { useState } from "react";
import axios from "axios";

const colors = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];

const CodeEditor = () => {
  const { currentUser, logout } = useAuth();
  const editorRef = useRef(null);
  const providerRef = useRef(null);
  const socketRef = useRef(null);
  const awarenessRef = useRef(null);
  const ydocRef = useRef(null);
  const { roomId } = useParams();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [activeUsers, setActiveUsers] = useState([]);
  const [output, setOutput] = useState("");
  const [isExecuting, setIsExecuting] = useState(false);

  const runCode = () => {
    if (!providerRef.current) return;
    const code = providerRef.current.doc.getText("monaco").toString();
    if (!code.trim()) {
       setOutput("Please enter some code to run.");
       return;
    }
    
    setIsExecuting(true);
    setOutput("Running...\n");

    setTimeout(() => {
      let logs = [];
      const originalConsoleLog = console.log;
      console.log = (...args) => {
          logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(" "));
          originalConsoleLog(...args);
      };

      try {
          new Function(code)();
          setOutput(logs.join("\n") + "\n\n=== Code executed successfully ===");
      } catch (err) {
          setOutput("Error executing code:\n" + err.toString());
      } finally {
          console.log = originalConsoleLog;
          setIsExecuting(false);
      }
    }, 300);
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const awareness = new awarenessProtocol.Awareness(ydoc);
    awarenessRef.current = awareness;

    // Pick a random color for the current user's cursor
    const myColor = colors[Math.floor(Math.random() * colors.length)];
    
    // Set awareness local state for other users to see
    if (currentUser) {
      awareness.setLocalStateField("user", {
        name: currentUser.name,
        color: myColor,
      });
    }

    const styleId = "yjs-cursors";
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }

    // Listen to changes in awareness (i.e. users joining/leaving)
    awareness.on("change", () => {
      const users = [];
      let cssRules = "";

      Array.from(awareness.getStates().entries()).forEach(([clientId, state]) => {
        if (state.user) {
          users.push(state.user);
          cssRules += `
            .yRemoteSelectionHead-${clientId}::after {
              content: "${state.user.name}";
              position: absolute;
              top: -24px;
              left: -2px;
              background-color: ${state.user.color};
              color: white;
              padding: 2px 6px;
              border-radius: 4px;
              font-size: 12px;
              font-weight: 500;
              white-space: nowrap;
              pointer-events: none;
              z-index: 100;
              box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            }
          `;
        }
      });
      setActiveUsers(users);
      if (styleEl) styleEl.innerHTML = cssRules;
    });

    const SOCKET_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join_room", roomId);
    });

    // Receive doc updates from server
    socket.on("yjs-update", ({ update }) => {
      Y.applyUpdate(ydoc, new Uint8Array(update));
    });

    // Receive cursor/awareness updates from other users
    socket.on("awareness-update", ({ update }) => {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        new Uint8Array(update),
        "remote"
      );
    });

    // Server requests us to send our awareness state
    socket.on("awareness-request", () => {
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [
        ydoc.clientID,
      ]);
      socket.emit("awareness-update", {
        roomId,
        update: Array.from(update),
      });
    });

    // Send our local doc changes to server
    ydoc.on("update", (update) => {
      socket.emit("yjs-update", {
        roomId,
        update: Array.from(update),
      });
    });

    // Send our local cursor/awareness changes to server
    awareness.on("update", ({ added, updated, removed }) => {
      const changedClients = [...added, ...updated, ...removed];
      const update = awarenessProtocol.encodeAwarenessUpdate(
        awareness,
        changedClients
      );
      socket.emit("awareness-update", {
        roomId,
        update: Array.from(update),
      });
    });

    providerRef.current = { doc: ydoc, awareness };

    if (editorRef.current) {
      bindMonaco(editorRef.current, ydoc, awareness);
    }

    return () => {
      awareness.destroy();
      ydoc.destroy();
      socket.disconnect();
    };
  }, [roomId, currentUser]);

  const bindMonaco = (editor, ydoc, awareness) => {
    const yText = ydoc.getText("monaco");
    new MonacoBinding(
      yText,
      editor.getModel(),
      new Set([editor]),
      awareness
    );
  };

  const handleEditorMount = (editor) => {
    editorRef.current = editor;
    
    // Inject dynamic CSS variable for current user cursor color
    const state = awarenessRef.current?.getLocalState();
    if (state?.user?.color) {
      document.documentElement.style.setProperty("--cursor-color", state.user.color);
    }

    if (providerRef.current) {
      const { doc: ydoc, awareness } = providerRef.current;
      bindMonaco(editor, ydoc, awareness);
    }
  };

  return (
    <div className="editor-container">
      <div className="editor-header">
        <div className="room-info">
          <span className="logo-text" style={{ fontSize: "1rem" }}>CollabCompile</span>
          <div className="room-badge">Room: {roomId}</div>
          <button 
            onClick={copyRoomCode} 
            className="icon-btn" 
            style={{ 
              background: "rgba(255,255,255,0.05)", 
              padding: "0.25rem 0.5rem", 
              borderRadius: "4px",
              gap: "4px"
            }}
          >
            {copied ? <Check size={14} color="var(--success)"/> : <LinkIcon size={14} />}
            <span style={{ fontSize: "0.8rem", color: copied ? "var(--success)" : "inherit" }}>
              {copied ? "Copied" : "Copy Code"}
            </span>
          </button>
        </div>
        
        <div className="user-section" style={{ gap: "1rem" }}>
          <button 
            onClick={runCode}
            disabled={isExecuting}
            className="primary-btn glow-effect"
            style={{ 
              padding: "0.4rem 1rem", 
              fontSize: "0.85rem", 
              display: "flex", 
              alignItems: "center", 
              gap: "0.5rem", 
              marginRight: "0.5rem"
            }}
          >
            <Play size={14} fill="currentColor" />
            {isExecuting ? "Running..." : "Run"}
          </button>
          {/* Active Users Avatars */}
          <div style={{ display: "flex", alignItems: "center" }}>
            {activeUsers.map((u, i) => (
              <div 
                key={i}
                title={u.name}
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  backgroundColor: u.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontSize: "12px",
                  fontWeight: "bold",
                  marginLeft: i > 0 ? "-8px" : "0",
                  border: "2px solid var(--surface)",
                  zIndex: activeUsers.length - i
                }}
              >
                {u.name.charAt(0).toUpperCase()}
              </div>
            ))}
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginLeft: "0.5rem" }}>
              {activeUsers.length} online
            </span>
          </div>

          <span className="welcome-text" style={{ fontSize: "0.9rem" }}>
            {currentUser?.name}
          </span>
          <button onClick={handleLogout} className="icon-btn">
            <LogOut size={16} />
          </button>
        </div>
      </div>
      <div className="editor-workspace" style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, borderRight: "1px solid rgba(255,255,255,0.05)" }}>
          <Editor
            height="100%"
            defaultLanguage="javascript"
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              padding: { top: 16 },
              fontFamily: "'Fira Code', 'Inter', monospace",
              fontSize: 14,
            }}
            onMount={handleEditorMount}
          />
        </div>
        <div className="output-panel" style={{ 
            width: "35%", 
            background: "var(--surface)", 
            display: "flex", 
            flexDirection: "column",
            boxShadow: "-4px 0 15px rgba(0,0,0,0.2)",
            zIndex: 5
        }}>
          <div style={{ 
            padding: "0.75rem 1rem", 
            borderBottom: "1px solid rgba(255,255,255,0.05)",
            fontWeight: "600",
            fontSize: "0.85rem",
            color: "var(--text-muted)",
            display: "flex",
            alignItems: "center",
            background: "rgba(15, 23, 42, 0.5)"
          }}>
            Terminal Output
          </div>
          <div style={{ 
            padding: "1rem", 
            flex: 1, 
            overflowY: "auto",
            fontFamily: "'Fira Code', 'Inter', monospace",
            fontSize: "13px",
            whiteSpace: "pre-wrap",
            color: output.includes("Error:") ? "var(--error)" : "var(--text-main)",
            lineHeight: "1.6"
          }}>
            {output || 'Output will appear here...'}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CodeEditor;