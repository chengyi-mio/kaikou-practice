const resume = "我有五年产品设计经验，负责需求分析、项目交付和团队沟通。";
const job = "负责产品规划和需求分析，协调研发团队推进项目按期落地。";
export async function prepare(page: import("@playwright/test").Page) {
  await page.goto("/#/interview");
  await page
    .getByRole("button", { name: "LIVE 实时面试", exact: true })
    .click();
  if(!await page.getByLabel('岗位名称（选填）').isVisible()) await page.locator('.interview-materials > summary').click();
  await page.getByLabel("岗位名称（选填）").fill("产品经理");
  const areas = page.locator(".interview-columns textarea");
  await areas.nth(0).fill(resume);
  await areas.nth(1).fill(job);
  await page.locator(".live-panel > .live-consent input").check();
}
export async function nativePeer(page: import("@playwright/test").Page) {
  await page.route("**/api/realtime/status", (r) =>
    r.fulfill({ json: { configured: true, model: "test-peer", trial: { ready: true, message: "隔离测试：虚构额度确认" } } }),
  );
  await page.route("**/api/realtime/session", async (route) => {
    const request = route.request().postDataJSON();
    // Test provider is another real browser WebRTC peer. No paid AI request.
    const sdp = await page.evaluate(async (offer) => {
      const w = window as any;
      w.__liveRequests = [...(w.__liveRequests || []), offer];
      w.__providerEvents = [];
      const pc = new RTCPeerConnection({ iceServers: [] });
      w.__provider = pc;
      const context = new AudioContext();
      w.__audioContext = context;
      const tone = context.createOscillator();
      tone.frequency.value = 220;
      const destination = context.createMediaStreamDestination();
      const gain = context.createGain();
      gain.gain.value = 0.1;
      tone.connect(gain).connect(destination);
      tone.start();
      pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
      pc.ontrack = (e) => {
        w.__remoteMic = e.track;
      };
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        w.__channel = dc;
        w.__emit = (events: any[]) =>
          events.forEach((event) =>
            dc.send(
              JSON.stringify({ ...event, event_id: crypto.randomUUID() }),
            ),
          );
        dc.onopen = () => w.__emit([{ type: "session.created" }]);
        dc.onmessage = (message) => {
          const event = JSON.parse(message.data);
          w.__providerEvents.push(event);
          if (event.type === "session.update")
            w.__emit([{ type: "session.updated" }]);
          if (event.type === "response.create")
            w.__emit([
              { type: "response.created" },
              {
                type: "response.audio_transcript.done",
                item_id: "q1",
                transcript: "请介绍你负责的一次产品项目？",
              },
            ]);
          if (event.type === "response.cancel")
            w.__emit([
              {
                type: "response.done",
                response: { id: "r0", status: "cancelled" },
              },
            ]);
        };
      };
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== "complete")
        await new Promise<void>((resolve) => {
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") resolve();
          };
        });
      return pc.localDescription!.sdp;
    }, request);
    await route.fulfill({
      json: {
        sdp,
        session: {
          modalities: ["text", "audio"],
          instructions: "isolated test interviewer",
        },
        maxSeconds: request.minutes * 60,
      },
    });
  });
}
