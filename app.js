const CONFIG = {
  soundEnabled: true,
  soundAtEnd: true,
  beepFrequency: 880,
  beepDuration: 0.12,
};
const SETTINGS = {
  delay: 0,
  duration: 0,
  beepInterval: 0
};
const TICK_MS = 100;

let TIMER = {
  status: "idle",   // idle | waiting | running | finished
  startTime: null,
  targetTime: null,
  endTime: null,
  remainingTime: 0
};
let audioContext = null;
let intervalId = null;
let scheduledOscs = [];
let wakeLock = null;

function isRunning() {
  return TIMER.status === "waiting" || TIMER.status === "running";
}

/* ==================================================================================== SOUND ==================================================================================== */

function playBeep(when) {
  if (!CONFIG.soundEnabled || !audioContext) return null;

  const t = when ?? audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = CONFIG.beepFrequency;

  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + CONFIG.beepDuration);

  oscillator.connect(gain);
  gain.connect(audioContext.destination);

  oscillator.start(t);
  oscillator.stop(t + CONFIG.beepDuration + 0.02);
  return oscillator;
}

function scheduleBeeps() {
  if (!audioContext) return;

  const base = audioContext.currentTime + SETTINGS.delay;
  const interval = SETTINGS.beepInterval;
  const duration = SETTINGS.duration;

  if (interval > 0) {
    for (let k = 0; k * interval < duration - 0.001; k++) {
      scheduledOscs.push(playBeep(base + k * interval));
    }
  }
  if (CONFIG.soundAtEnd) {
    scheduledOscs.push(playBeep(base + duration));
  }
}

function cancelBeeps() {
  scheduledOscs.forEach(o => { try { o && o.stop(); } catch (e) {} });
  scheduledOscs = [];
}

async function initAudio() {
  if (navigator.audioSession) navigator.audioSession.type = "playback";

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (AudioContextClass && !audioContext) {
    audioContext = new AudioContextClass();
  }

  if (audioContext && audioContext.state === "suspended") {
    await audioContext.resume();
  }

  console.log("Audio context:", audioContext?.state);
}

async function testBeep() {
  if (isRunning()) return;
  await initAudio();
  playBeep();
}

/* ==================================================================================== Screen lock ==================================================================================== */

const SLEEP_NOTICE_DEFAULT =
  "Keep this screen on while the timer runs: locking your device can stop the timer and the beeps.";
const SLEEP_NOTICE_WARNING =
  "Your device may fall asleep during the timer. Turn off auto-lock in your device SETTINGS to keep the timer and beeps running.";

function setSleepNotice(isWarning) {
  const notice = document.getElementById("sleepNotice");
  notice.textContent = isWarning ? SLEEP_NOTICE_WARNING : SLEEP_NOTICE_DEFAULT;
  notice.classList.toggle("warning", isWarning);
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) {
    setSleepNotice(true);
    return;
  }
  if (wakeLock) return;

  try {
    const lock = await navigator.wakeLock.request("screen");

    if (!isRunning()) {
      lock.release().catch(() => {});
      return;
    }

    wakeLock = lock;
    setSleepNotice(false);
    lock.addEventListener("release", () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch (e) {
    console.log("WakeLock:", e);
    setSleepNotice(true);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isRunning()) {
    requestWakeLock();
    updateTimer();
  }
});

/* ==================================================================================== Time presentation ==================================================================================== */

function readNumber(id, fallback, min = 0) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function readTime(minutesId, secondsId) {
  const minutes = readNumber(minutesId, 0);
  const seconds = readNumber(secondsId, 0);

  return minutes * 60 + seconds;
}

function updateConfigFromInput() {
  SETTINGS.delay = readTime("delayMinutes", "delaySeconds");
  SETTINGS.duration = readTime("durationMinutes", "durationSeconds");
  SETTINGS.beepInterval = readTime("beepMinutes", "beepSeconds");
}

/* ==================================================================================== Timer ==================================================================================== */

async function startTimer() {
  if (TIMER.status !== "idle" && TIMER.status !== "finished") {
    return;
  }

  updateConfigFromInput();

  if (SETTINGS.duration <= 0) return;

  TIMER.remainingTime = SETTINGS.duration * 1000;

  await initAudio();

  cancelBeeps();
  scheduleBeeps();

  TIMER.startTime = Date.now();
  TIMER.targetTime = TIMER.startTime + SETTINGS.delay * 1000;
  TIMER.status = "waiting";

  requestWakeLock();

  intervalId = setInterval(updateTimer, TICK_MS);
  updateTimer();
}

function resetTimer() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  cancelBeeps();
  releaseWakeLock();

  TIMER.status = "idle";
  TIMER.startTime = null;
  TIMER.targetTime = null;
  TIMER.endTime = null;
  TIMER.remainingTime = SETTINGS.duration * 1000;

  renderTimer();
}

function handleTimerButton() {
  if (TIMER.status === "idle" || TIMER.status === "finished") {
    startTimer();
  } else {
    resetTimer();
  }
}

function updatePreview() {
  if (isRunning()) return;

  TIMER.status = "idle";
  updateConfigFromInput();
  TIMER.remainingTime = SETTINGS.duration * 1000;

  renderTimer();
}

function updateTimer() {
  const now = Date.now();

  if (TIMER.status === "waiting" && now >= TIMER.targetTime) {
    TIMER.status = "running";
    TIMER.endTime = TIMER.targetTime + SETTINGS.duration * 1000;
    console.log("Countdown Started");
  }

  if (TIMER.status === "running") {
    TIMER.remainingTime = Math.max(0, TIMER.endTime - now);

    if (TIMER.remainingTime <= 0) {
      TIMER.status = "finished";
      clearInterval(intervalId);
      intervalId = null;
      releaseWakeLock();
      console.log("Countdown Finished");
    }
  }

  renderTimer();
}

/* ==================================================================================== Display ==================================================================================== */

function formatSmartTime(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);

  if (totalSeconds < 60) {
    return totalSeconds + " s";
  }

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes < 60) {
    return totalMinutes + " min " + String(seconds).padStart(2, "0") + " s";
  }

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return hours + " h " + String(minutes).padStart(2, "0") + " min";
}

function renderTimer() {
  const display = document.getElementById("timerDisplay");
  const button = document.getElementById("mainButton");
  const testButton = document.getElementById("testBeepButton");
  const delayDisplay = document.getElementById("delayDisplay");

  display.textContent = formatSmartTime(TIMER.remainingTime);

  let delayMs = null;

  if (TIMER.status === "waiting") {
    delayMs = Math.max(0, TIMER.targetTime - Date.now());
  } else if (TIMER.status === "idle") {
    delayMs = readTime("delayMinutes", "delaySeconds") * 1000;
  }

  delayDisplay.textContent =
    delayMs === null ? "" : "Start in " + formatSmartTime(delayMs);

  button.textContent = isRunning() ? "RESET" : "START";

  const locked = isRunning();
  testButton.disabled = locked;
  testButton.style.opacity = locked ? "0.4" : "1";
  testButton.style.cursor = locked ? "not-allowed" : "pointer";
}

updatePreview();
