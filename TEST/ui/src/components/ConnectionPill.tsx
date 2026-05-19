import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { checkHealth } from "../api";

type Status = "checking" | "ok" | "down";

// Polls /health/live every 8s. Renders a status pill the user can glance at
// to know whether the backend is reachable. Pulses while checking; turns
// green on ok, red on down.

export function ConnectionPill(): JSX.Element {
  const [status, setStatus] = useState<Status>("checking");
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick(): Promise<void> {
      const t0 = performance.now();
      try {
        await checkHealth();
        if (!cancelled) {
          setStatus("ok");
          setLatency(Math.round(performance.now() - t0));
        }
      } catch {
        if (!cancelled) {
          setStatus("down");
          setLatency(null);
        }
      }
      if (!cancelled) timer = setTimeout(tick, 8000);
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const label =
    status === "ok"       ? `Online · ${latency ?? "?"}ms` :
    status === "down"     ? "Backend offline" :
    "Connecting…";

  return (
    <motion.div
      className="connection-pill"
      data-status={status}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <span className="dot" />
      <span>{label}</span>
    </motion.div>
  );
}
