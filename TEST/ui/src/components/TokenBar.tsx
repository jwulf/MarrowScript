import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { getToken, setToken } from "../api";

interface Props {
  onChange?: () => void;
}

// Token bar — frontend devs paste in the JWT they minted via
//   npx ts-node bin/mint_dev_token.ts --sub frontend-dev
// We persist it in localStorage so refreshes keep them logged in. Empty
// token = unauthenticated; the API will return 401 and the UI will show
// the no-token notice.
//
// onChange fires after every keystroke so the parent can re-evaluate
// the "Forge" button's disabled state in the same render. Without this
// callback the parent only re-evaluates on cross-tab storage events,
// which means typing in the bar wouldn't enable the button until reload.

export function TokenBar({ onChange }: Props): JSX.Element {
  const [token, setLocal] = useState<string>(getToken());
  const [showToken, setShowToken] = useState<boolean>(false);

  useEffect(() => {
    setToken(token);
    onChange?.();
  }, [token]);

  const masked = token ? `${token.slice(0, 12)}…${token.slice(-6)}` : "";

  return (
    <motion.div
      className="token-bar"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <span className="label">Token</span>
      <input
        type={showToken ? "text" : "password"}
        value={token}
        onChange={(e) => setLocal(e.target.value)}
        placeholder="Paste JWT from `npx ts-node bin/mint_dev_token.ts`"
        spellCheck={false}
        autoComplete="off"
      />
      <button
        className="copy-btn"
        onClick={() => setShowToken((s) => !s)}
        title={showToken ? "Hide token" : "Show token"}
      >
        {showToken ? "Hide" : "Show"}
      </button>
      {token ? <span className="badge badge-ok mono">{masked}</span> : <span className="badge mono">No token</span>}
    </motion.div>
  );
}
