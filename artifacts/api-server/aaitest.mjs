import WebSocket from "ws";
const key = process.env.ASSEMBLYAI_API_KEY;
const ws = new WebSocket(
  "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&format_turns=true&speech_model=universal-streaming-multilingual",
  { headers: { Authorization: key } }
);
ws.on("open", () => {
  console.log("UPSTREAM OPEN");
  setTimeout(() => {
    const buf = Buffer.alloc(6400);
    for (let i = 0; i < 10; i++) ws.send(buf);
    console.log("sent silent chunks");
  }, 200);
});
ws.on("message", (d) => console.log("MSG:", d.toString().slice(0, 400)));
ws.on("close", (code, reason) =>
  console.log("CLOSE code=", code, " reason=", reason.toString().slice(0, 400))
);
ws.on("error", (e) => console.log("ERR:", e.message));
setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, 6000);
