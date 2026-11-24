(() => {
  const ns = (globalThis.FuelWise ??= {});
  function createRequestQueue(timeoutMs) {
    let previous = Promise.resolve();
    let lastStart = 0;
    return (url) => {
      const pending = previous.then(async () => {
        const wait = 1100 - (Date.now() - lastStart);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastStart = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            headers: { Accept: "application/json" }, referrerPolicy: "origin", signal: controller.signal,
          });
          let payload = null;
          if (response.ok) {
            try {
              payload = await response.json();
            } catch (error) {
              if (error.name !== "SyntaxError") throw error;
            }
          }
          return { ok: response.ok, status: response.status, payload };
        } finally {
          clearTimeout(timer);
        }
      });
      previous = pending.catch(() => {});
      return pending;
    };
  }
  ns.createRequestQueue = createRequestQueue;
})();
