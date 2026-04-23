import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

router.post("/token", async (req: Request, res: Response): Promise<void> => {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ASSEMBLYAI_API_KEY not configured" });
    return;
  }

  try {
    const r = await fetch(
      "https://streaming.assemblyai.com/v3/token?expires_in_seconds=120",
      {
        method: "GET",
        headers: { Authorization: apiKey },
      }
    );

    if (!r.ok) {
      const text = await r.text();
      res.status(r.status).json({ error: `Token request failed: ${text}` });
      return;
    }

    const data = (await r.json()) as { token: string };
    res.json({ token: data.token });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
