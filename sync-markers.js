/**
 * sync-markers.js
 * ================
 * Drop-in synchronization module for your 3-day experiment.
 * Add ONE <script> tag to each day's HTML. That's all.
 *
 * WHAT IT DOES:
 *   1. Records video via the PC webcam (MediaRecorder API — no OBS needed,
 *      but OBS is also supported if you prefer higher quality)
 *   2. Stamps task-boundary markers into the video timeline (via a
 *      visible overlay + a parallel timestamp track)
 *   3. Sends the same marker to the Python sync_bridge → Shimmer serial
 *   4. Writes a CSV log with ms-precise wallclock timestamps for both systems
 *
 * USAGE:
 *   Step 1 — add to <head> of EACH day's HTML:
 *       <script src="sync-markers.js"></script>
 *
 *   Step 2 — at the very top of your experiment JS, call:
 *       SyncMarkers.init({ participantId: "P07", day: 1 });
 *       // This starts camera recording immediately.
 *
 *   Step 3 — wrap every existing task-boundary call like this:
 *       SyncMarkers.send("baseline_start");
 *       // ... task runs ...
 *       SyncMarkers.send("baseline_end");
 *
 *   Step 4 — at the very end of the experiment (thank-you page):
 *       SyncMarkers.finish();
 *       // Downloads: video file + marker CSV
 *
 * FULL EVENT NAME LIST (use exactly these strings):
 *
 *   ALL DAYS:
 *     baseline_start / baseline_end
 *     affective_slider_start / affective_slider_end
 *     memory_test_start / memory_test_end
 *     binary_probe_start / binary_probe_end
 *
 *   DAY 1:
 *     shape_preference_start / shape_preference_end
 *     slot_machine_start / slot_machine_end         ← 50-round conditioning
 *
 *   DAY 2:
 *     memory_retrieval_start / memory_retrieval_end  ← 10-round no-reward
 *     digit_cancellation_start / digit_cancellation_end
 *     word_fragment_start / word_fragment_end
 *     breathing_task_start / breathing_task_end      ← PNS activation
 *     trail_making_start / trail_making_end
 *     counterconditioning_start / counterconditioning_end
 *     cold_pressor_start / cold_pressor_end
 *
 *   DAY 3:
 *     reinstatement_start / reinstatement_end        ← 10-round, no shapes
 *     choice_task_start / choice_task_end
 *
 *   AUTOMATIC (called by init() and finish()):
 *     session_start / session_end
 */

const SyncMarkers = (() => {

  // ── Config (overridden by init()) ──────────────────────────────────────────
  let CFG = {
    participantId:   "P00",
    day:             1,
    bridgeUrl:       "http://127.0.0.1:5000/marker",
    videoBitsPerSec: 2_500_000,    // 2.5 Mbps — good quality, manageable file size
    videoMimeType:   "",           // auto-detected
    showOverlay:     true,         // on-screen marker badge
    obsMode:         false,        // set true if you prefer OBS over built-in camera
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let mediaRecorder  = null;
  let videoChunks    = [];
  let recordingStart = null;   // performance.now() when recording began
  let markerLog      = [];
  let overlayEl      = null;
  let overlayTimer   = null;
  let cameraStream   = null;
  let isFinished     = false;

  // ── Public: init ──────────────────────────────────────────────────────────
  async function init(options = {}) {
    Object.assign(CFG, options);
    _createOverlay();

    // Ping bridge (non-blocking — just warn if not reachable)
    fetch(CFG.bridgeUrl.replace("/marker", "/ping"))
      .then(r => r.json())
      .then(d => {
        const shimOk = d.shimmer_open ? "✓" : "✗ NOT connected";
        const obsOk  = d.obs_connected ? "✓" : "✗ not connected";
        console.log(`[SYNC] Bridge reachable  Shimmer=${shimOk}  OBS=${obsOk}`);
        _badge(`Bridge OK | Shimmer: ${d.shimmer_open ? "✓" : "✗"}`);
      })
      .catch(() => console.warn("[SYNC] sync_bridge.py not running — markers will be local only"));

    // Start camera
    await _startCamera();

    // Fire session_start marker
    await send("session_start");
    console.log(`[SYNC] Ready  participant=${CFG.participantId}  day=${CFG.day}`);
  }

  // ── Public: send ─────────────────────────────────────────────────────────
  async function send(eventName, extraData = {}) {
    const wallclock   = new Date().toISOString();
    const perfMs      = performance.now();
    const videoOffsetMs = recordingStart != null
      ? Math.round(perfMs - recordingStart)
      : null;

    _badge(eventName);
    console.log(`[SYNC] ▶ ${eventName}  t=${videoOffsetMs}ms`);

    // Send to bridge (GSR + OBS)
    let bridgeOk = false;
    try {
      const res = await fetch(CFG.bridgeUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          event:       eventName,
          wallclock,
          participant: CFG.participantId,
          day:         CFG.day,
        }),
      });
      const json = await res.json();
      bridgeOk = json.status === "ok";
    } catch {
      console.warn(`[SYNC] Bridge unreachable for: ${eventName}`);
    }

    // Log locally
    markerLog.push({
      participant:    CFG.participantId,
      day:            CFG.day,
      event:          eventName,
      wallclock,
      perf_ms:        perfMs.toFixed(1),
      video_offset_ms: videoOffsetMs,
      bridge_ok:      bridgeOk,
      ...extraData,
    });

    return bridgeOk;
  }

  // ── Public: finish ────────────────────────────────────────────────────────
  async function finish() {
    if (isFinished) return;
    isFinished = true;

    await send("session_end");

    // Tell bridge to save its log too
    fetch(CFG.bridgeUrl.replace("/marker", "/save_log"), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ participant: CFG.participantId }),
    }).catch(() => {});

    // Stop camera recording and download files
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();   // onstop handler will trigger downloads
    } else {
      _downloadCSV();
    }

    console.log("[SYNC] Session complete. Files downloading...");
  }

  // ── Camera recording ──────────────────────────────────────────────────────
  async function _startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false,
      });

      // Detect supported MIME type
      const mimeTypes = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
        "video/mp4",
      ];
      CFG.videoMimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || "";

      mediaRecorder = new MediaRecorder(cameraStream, {
        mimeType:           CFG.videoMimeType,
        videoBitsPerSecond: CFG.videoBitsPerSec,
      });

      mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) videoChunks.push(e.data);
      };

      mediaRecorder.onstart = () => {
        recordingStart = performance.now();
        console.log("[SYNC] Camera recording started ✓");
        _badge("Camera recording...");
      };

      mediaRecorder.onstop = () => {
        console.log("[SYNC] Camera recording stopped. Building video file...");
        _downloadVideo();
        _downloadCSV();
        cameraStream.getTracks().forEach(t => t.stop());
      };

      // Collect a chunk every 5 s (so data isn't lost if page closes)
      mediaRecorder.start(5000);

    } catch (err) {
      console.error("[SYNC] Camera access failed:", err.message);
      _badge("⚠ Camera unavailable");
      // Continue without video — GSR markers still work
    }
  }

  // ── Downloads ─────────────────────────────────────────────────────────────
  function _downloadVideo() {
    if (videoChunks.length === 0) return;
    const ext  = CFG.videoMimeType.includes("mp4") ? "mp4" : "webm";
    const blob = new Blob(videoChunks, { type: CFG.videoMimeType || "video/webm" });
    _triggerDownload(
      blob,
      `video_P${CFG.participantId}_Day${CFG.day}_${_dateTag()}.${ext}`
    );
    console.log(`[SYNC] Video downloaded (${(blob.size / 1e6).toFixed(1)} MB)`);
  }

  function _downloadCSV() {
    if (markerLog.length === 0) return;
    const cols = Object.keys(markerLog[0]);
    const rows = markerLog.map(r =>
      cols.map(c => JSON.stringify(r[c] ?? "")).join(",")
    );
    const blob = new Blob(
      [cols.join(",") + "\n" + rows.join("\n")],
      { type: "text/csv" }
    );
    _triggerDownload(
      blob,
      `markers_P${CFG.participantId}_Day${CFG.day}_${_dateTag()}.csv`
    );
    console.log("[SYNC] Marker CSV downloaded");
  }

  function _triggerDownload(blob, filename) {
    const a = Object.assign(document.createElement("a"), {
      href:     URL.createObjectURL(blob),
      download: filename,
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── Overlay badge ─────────────────────────────────────────────────────────
  function _createOverlay() {
    if (!CFG.showOverlay) return;
    overlayEl = document.createElement("div");
    Object.assign(overlayEl.style, {
      position:      "fixed",
      bottom:        "10px",
      right:         "10px",
      background:    "rgba(0,0,0,0.80)",
      color:         "#00ff88",
      fontFamily:    "monospace",
      fontSize:      "11px",
      lineHeight:    "1.4",
      padding:       "6px 10px",
      borderRadius:  "5px",
      zIndex:        "999999",
      pointerEvents: "none",
      maxWidth:      "280px",
      userSelect:    "none",
    });
    overlayEl.textContent = "● SYNC: initializing…";
    document.body.appendChild(overlayEl);
  }

  function _badge(text) {
    if (!overlayEl) return;
    overlayEl.textContent = `● ${text}`;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      if (overlayEl) overlayEl.textContent = `● recording  P${CFG.participantId} Day${CFG.day}`;
    }, 2500);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function _dateTag() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  function getLog() { return [...markerLog]; }

  // ── Expose public API ─────────────────────────────────────────────────────
  return { init, send, finish, getLog };

})();

// Make it globally accessible too (for quick console testing)
window.SyncMarkers = SyncMarkers;
window.sendMarker  = (name) => SyncMarkers.send(name);
