import { useState, useCallback, useEffect } from "react";
import Editor from "@monaco-editor/react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

interface User {
  id: string;
  email: string;
  name: string;
  picture: string;
  total_compiles: number;
}

interface CompiledFile {
  path: string;
  content: string;
  language: string;
}

interface CompileResult {
  files: CompiledFile[];
  errors: string[];
  duration_ms: number;
}

const DEFAULT_SOURCE = `// Try MarrowScript! Edit this and hit Compile.

system MyApp {
  domain: saas_platform

  entity User {
    owns: [
      name: string,
      email: string,
      role: string
    ]
    constraints: [
      name.length in 1..100,
      email.unique,
      role in ["admin", "user", "moderator"]
    ]
    states: active -> suspended -> deleted
    auth: jwt
  }

  store UserStore {
    engine: postgresql
    schema: {
      id: uuid,
      name: string,
      email: string,
      role: string,
      created_at: timestamp
    }
  }

  event UserCreated {
    payload: {
      user_id: uuid,
      email: string,
      created_at: timestamp
    }
    delivery: at_least_once
    ttl: 30d
  }

  capability create_user(name: string, email: string) {
    requires: [name.length >= 1, email.length >= 3]
    effects: []
    emits: UserCreated
    sync: transactional
    timeout: 10s
  }

  policy api_security {
    rate_limit: 100 per 1m
    access: [admin, user]
    audit: true
    encryption: in_transit
  }
}
`;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem("token"));
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [target, setTarget] = useState("express");
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check auth on mount
  useEffect(() => {
    if (token) {
      fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(setUser)
        .catch(() => { setToken(null); localStorage.removeItem("token"); });
    }
  }, [token]);

  // Initialize Google One Tap
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || user) return;
    const initGoogle = () => {
      (window as any).google?.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleResponse,
      });
      (window as any).google?.accounts.id.renderButton(
        document.getElementById("google-signin-btn"),
        { theme: "filled_black", size: "medium", text: "signin_with" }
      );
    };
    // Wait for Google script to load
    if ((window as any).google?.accounts) initGoogle();
    else setTimeout(initGoogle, 1000);
  }, [user]);

  const handleGoogleResponse = useCallback(async (response: any) => {
    try {
      const res = await fetch(`${API_URL}/api/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: response.credential }),
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem("token", data.token);
      }
    } catch (e: any) {
      setError("Sign-in failed: " + e.message);
    }
  }, []);

  const handleCompile = useCallback(async () => {
    if (!token) { setError("Sign in to compile"); return; }
    setCompiling(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, target }),
      });
      const data = await res.json();
      if (res.status === 429) { setError(data.error); return; }
      if (res.status === 401) { setError("Session expired. Sign in again."); setUser(null); setToken(null); localStorage.removeItem("token"); return; }
      setResult(data);
      if (data.files?.length > 0) setSelectedFile(data.files[0].path);
    } catch (e: any) {
      setError("Compile failed: " + e.message);
    } finally {
      setCompiling(false);
    }
  }, [source, target, token]);

  const handleLoadExample = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${API_URL}/api/examples/${id}`);
      const data = await res.json();
      if (data.source) setSource(data.source);
    } catch {}
  }, []);

  const selectedContent = result?.files?.find(f => f.path === selectedFile)?.content || "";
  const selectedLang = result?.files?.find(f => f.path === selectedFile)?.language || "typescript";

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold text-white">MarrowScript Playground</h1>
          <select
            className="bg-gray-800 text-sm text-gray-300 rounded px-2 py-1 border border-gray-700"
            onChange={e => handleLoadExample(e.target.value)}
            defaultValue=""
          >
            <option value="" disabled>Load example...</option>
            <option value="marketplace">Marketplace</option>
            <option value="inventory">Inventory Platform</option>
            <option value="delivery">Delivery Platform</option>
            <option value="minimal">Minimal</option>
          </select>
          <select
            className="bg-gray-800 text-sm text-gray-300 rounded px-2 py-1 border border-gray-700"
            value={target}
            onChange={e => setTarget(e.target.value)}
          >
            <option value="express">Target: Express</option>
            <option value="sqlite">Target: SQLite</option>
            <option value="prisma">Target: Prisma</option>
            <option value="nakama">Target: Nakama</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          {result && <span className="text-xs text-gray-500">{result.files.length} files • {result.duration_ms}ms</span>}
          <button
            onClick={handleCompile}
            disabled={compiling || !user}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium px-4 py-1.5 rounded transition-colors"
          >
            {compiling ? "Compiling..." : "▶ Compile"}
          </button>
          {user ? (
            <div className="flex items-center gap-2">
              {user.picture && <img src={user.picture} className="w-7 h-7 rounded-full" alt="" />}
              <span className="text-sm text-gray-400">{user.name}</span>
            </div>
          ) : (
            <div id="google-signin-btn"></div>
          )}
        </div>
      </header>

      {/* Error bar */}
      {error && (
        <div className="bg-red-900/50 border-b border-red-800 px-4 py-2 text-sm text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-4 text-red-400 hover:text-red-200">✕</button>
        </div>
      )}

      {/* Compiler errors */}
      {result?.errors && result.errors.length > 0 && (
        <div className="bg-amber-900/30 border-b border-amber-800 px-4 py-2 text-sm text-amber-300 max-h-24 overflow-y-auto">
          {result.errors.map((e, i) => <div key={i} className="font-mono text-xs">{e}</div>)}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Editor */}
        <div className="w-1/2 border-r border-gray-800">
          <Editor
            height="100%"
            defaultLanguage="plaintext"
            theme="vs-dark"
            value={source}
            onChange={v => setSource(v || "")}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              wordWrap: "on",
              padding: { top: 8 },
            }}
          />
        </div>

        {/* Right: Output */}
        <div className="w-1/2 flex flex-col">
          {/* File tree */}
          <div className="h-36 overflow-y-auto border-b border-gray-800 bg-gray-900 p-2">
            {result?.files && result.files.length > 0 ? (
              <div className="grid grid-cols-2 gap-1">
                {result.files.map(f => (
                  <button
                    key={f.path}
                    onClick={() => setSelectedFile(f.path)}
                    className={`text-left text-xs px-2 py-1 rounded truncate ${
                      selectedFile === f.path ? "bg-emerald-900/50 text-emerald-300" : "text-gray-400 hover:bg-gray-800"
                    }`}
                  >
                    📄 {f.path}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-gray-600 text-sm text-center pt-8">
                {user ? "Hit Compile to see output" : "Sign in to start compiling"}
              </div>
            )}
          </div>

          {/* File content viewer */}
          <div className="flex-1">
            <Editor
              height="100%"
              language={selectedLang}
              theme="vs-dark"
              value={selectedContent}
              options={{
                readOnly: true,
                fontSize: 12,
                minimap: { enabled: false },
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                padding: { top: 8 },
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
