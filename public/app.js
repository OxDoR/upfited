const supa = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const PUBLIC_BUCKET_URL = `${SUPABASE_URL}/storage/v1/object/public/outfit-photos/`;

let currentUser = null;
let authMode = "signin"; // "signin" | "signup"
let deck = [];
let deckIndex = 0;

// ---------- helpers ----------
function $(sel) { return document.querySelector(sel); }
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2200);
}

function goScreen(name) {
  ["auth", "deck", "upload", "ranking"].forEach((s) => hide($(`#screen-${s}`)));
  show($(`#screen-${name}`));
  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.screen === name);
  });
  if (name === "deck") loadDeck();
  if (name === "upload") loadQuota();
  if (name === "ranking") loadRanking();
}

// ---------- auth ----------
// Event delegation for the mode-switch link (the <a> node is replaced via innerHTML each time)
$("#auth-switch-text").addEventListener("click", (e) => {
  if (e.target.id !== "auth-switch-link") return;
  e.preventDefault();
  authMode = authMode === "signin" ? "signup" : "signin";
  if (authMode === "signup") {
    $("#auth-title").textContent = "Create your account";
    $("#auth-sub").textContent = "Upload your first fit in a moment.";
    $("#btn-auth-submit").textContent = "Create account";
    $("#auth-switch-text").innerHTML = 'Already have an account? <a href="#" id="auth-switch-link">Log in</a>';
  } else {
    $("#auth-title").textContent = "Vote the fit";
    $("#auth-sub").textContent = "Upload your look. Let people decide.";
    $("#btn-auth-submit").textContent = "Log in";
    $("#auth-switch-text").innerHTML = 'Don\'t have an account? <a href="#" id="auth-switch-link">Create account</a>';
  }
});

$("#btn-toggle-password").addEventListener("click", () => {
  const input = $("#auth-password");
  const btn = $("#btn-toggle-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.textContent = show ? "Hide" : "Show";
});

$("#btn-auth-submit").addEventListener("click", async () => {
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || !password) return toast("Fill in email and password");

  const btn = $("#btn-auth-submit");
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    if (authMode === "signup") {
      const { error } = await supa.auth.signUp({ email, password });
      if (error) throw error;
      toast("Account created. Welcome!");
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    toast(translateAuthError(err.message));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

$("#btn-google-auth").addEventListener("click", async () => {
  await supa.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
});

function translateAuthError(msg) {
  if (/already registered/i.test(msg)) return "That email is already registered";
  if (/invalid login/i.test(msg)) return "Incorrect email or password";
  if (/password/i.test(msg) && /6/.test(msg)) return "Password needs at least 6 characters";
  return msg;
}

$("#premium-pill").addEventListener("click", async () => {
  if (confirm("Log out?")) {
    await supa.auth.signOut();
  }
});

// ---------- nav ----------
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => goScreen(btn.dataset.screen));
});

// ---------- deck ----------
async function loadDeck() {
  const stage = $("#deck-stage");
  stage.innerHTML = '<div class="spinner" style="border-top-color:var(--primary);border-color:rgba(108,92,231,0.25)"></div>';
  const { data, error } = await supa.rpc("get_deck", { p_limit: 15 });
  if (error) {
    stage.innerHTML = `<div class="empty-state"><span class="big-emoji">&#10005;</span>Couldn't load the deck.</div>`;
    return;
  }
  deck = data || [];
  deckIndex = 0;
  renderCard();
}

function renderCard() {
  const stage = $("#deck-stage");
  const actions = $("#deck-actions");
  if (deckIndex >= deck.length) {
    hide(actions);
    stage.innerHTML = `<div class="empty-state"><span class="big-emoji">&#9733;</span>You've seen all today's fits.<br>Come back later.</div>`;
    return;
  }
  show(actions);
  const post = deck[deckIndex];
  const imgUrl = PUBLIC_BUCKET_URL + post.image_path;
  stage.innerHTML = `
    <div class="card-outfit">
      <img src="${imgUrl}" alt="outfit" />
      <div class="card-footer">
        <div class="card-name">Fit #${deckIndex + 1}</div>
        ${post.affiliate_link ? `<a class="card-link" href="${post.affiliate_link}" target="_blank" rel="noopener">Shop the look →</a>` : ""}
      </div>
    </div>
  `;
}

async function voteCurrent(action) {
  if (deckIndex >= deck.length) return;
  const post = deck[deckIndex];
  deckIndex++;
  renderCard();
  const { error } = await supa.from("interactions").insert({
    user_id: currentUser.id,
    post_id: post.id,
    action,
  });
  if (error) console.error("interaction error", error);
}

$("#btn-like").addEventListener("click", () => voteCurrent("like"));
$("#btn-pass").addEventListener("click", () => voteCurrent("skip"));

// ---------- upload / crop ----------
let selectedFile = null;
let cropState = null; // { naturalW, naturalH, scale, minScale, x, y }
const OUT_W = 1000;
const OUT_H = 1333; // same 3:4 ratio as the deck cards

function getCropViewportSize() {
  const rect = $("#crop-viewport").getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

function clampCrop() {
  const { w: vw, h: vh } = getCropViewportSize();
  const dispW = cropState.naturalW * cropState.scale;
  const dispH = cropState.naturalH * cropState.scale;
  const minX = Math.min(0, vw - dispW);
  const minY = Math.min(0, vh - dispH);
  cropState.x = Math.max(minX, Math.min(0, cropState.x));
  cropState.y = Math.max(minY, Math.min(0, cropState.y));
}

function renderCrop() {
  $("#crop-img").style.transform = `translate(${cropState.x}px, ${cropState.y}px) scale(${cropState.scale})`;
}

function initCrop(imgEl) {
  const { w: vw, h: vh } = getCropViewportSize();
  const coverScale = Math.max(vw / imgEl.naturalWidth, vh / imgEl.naturalHeight);
  cropState = {
    naturalW: imgEl.naturalWidth,
    naturalH: imgEl.naturalHeight,
    scale: coverScale,
    minScale: coverScale,
    x: (vw - imgEl.naturalWidth * coverScale) / 2,
    y: (vh - imgEl.naturalHeight * coverScale) / 2,
  };
  $("#zoom-range").value = 1;
  clampCrop();
  renderCrop();
}

function resetCropUI() {
  selectedFile = null;
  cropState = null;
  $("#upload-input").value = "";
  hide($("#crop-wrap"));
  show($("#upload-box"));
}

$("#upload-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    const img = $("#crop-img");
    img.onload = () => {
      hide($("#upload-box"));
      show($("#crop-wrap"));
      initCrop(img);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

$("#btn-change-photo").addEventListener("click", resetCropUI);

// drag to reposition (mouse and touch)
let dragging = false;
let dragStart = { x: 0, y: 0, cropX: 0, cropY: 0 };

function cropPointerDown(e) {
  if (!cropState) return;
  dragging = true;
  $("#crop-viewport").classList.add("dragging");
  const p = e.touches ? e.touches[0] : e;
  dragStart = { x: p.clientX, y: p.clientY, cropX: cropState.x, cropY: cropState.y };
}
function cropPointerMove(e) {
  if (!dragging || !cropState) return;
  const p = e.touches ? e.touches[0] : e;
  cropState.x = dragStart.cropX + (p.clientX - dragStart.x);
  cropState.y = dragStart.cropY + (p.clientY - dragStart.y);
  clampCrop();
  renderCrop();
  e.preventDefault();
}
function cropPointerUp() {
  dragging = false;
  $("#crop-viewport").classList.remove("dragging");
}

const cropViewportEl = $("#crop-viewport");
cropViewportEl.addEventListener("mousedown", cropPointerDown);
window.addEventListener("mousemove", cropPointerMove);
window.addEventListener("mouseup", cropPointerUp);
cropViewportEl.addEventListener("touchstart", cropPointerDown, { passive: true });
cropViewportEl.addEventListener("touchmove", cropPointerMove, { passive: false });
cropViewportEl.addEventListener("touchend", cropPointerUp);

$("#zoom-range").addEventListener("input", (e) => {
  if (!cropState) return;
  const { w: vw, h: vh } = getCropViewportSize();
  const zoom = parseFloat(e.target.value); // 1..3
  const cx = vw / 2, cy = vh / 2;
  const imgCx = (cx - cropState.x) / cropState.scale;
  const imgCy = (cy - cropState.y) / cropState.scale;
  cropState.scale = cropState.minScale * zoom;
  cropState.x = cx - imgCx * cropState.scale;
  cropState.y = cy - imgCy * cropState.scale;
  clampCrop();
  renderCrop();
});

function renderCroppedBlob(quality = 0.85) {
  return new Promise((resolve) => {
    const { w: vw } = getCropViewportSize();
    const outScale = OUT_W / vw;
    const canvas = document.createElement("canvas");
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      $("#crop-img"),
      0, 0, cropState.naturalW, cropState.naturalH,
      cropState.x * outScale, cropState.y * outScale,
      cropState.naturalW * cropState.scale * outScale,
      cropState.naturalH * cropState.scale * outScale
    );
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

async function loadQuota() {
  const { data, error } = await supa
    .from("profiles")
    .select("posts_today, is_premium, last_post_date")
    .eq("id", currentUser.id)
    .single();

  const banner = $("#quota-banner");
  if (error || !data) {
    banner.textContent = "Couldn't check your quota.";
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const postsToday = data.last_post_date === today ? data.posts_today : 0;

  if (data.is_premium) {
    banner.innerHTML = `<span>Premium <strong>account</strong></span><span>Unlimited posts</span>`;
  } else if (postsToday >= 1) {
    banner.innerHTML = `<span>Daily limit reached</span><button type="button" class="pill premium">Go Premium</button>`;
  } else {
    banner.innerHTML = `<span>Free photo today</span><strong>available</strong>`;
  }
}

// ---------- premium (Stripe Checkout) ----------
$("#quota-banner").addEventListener("click", (e) => {
  if (!e.target.classList.contains("premium")) return;
  goPremiumCheckout();
});

async function goPremiumCheckout() {
  const { data: { session } } = await supa.auth.getSession();
  if (!session) return toast("Please sign in first");
  toast("Opening checkout…");
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/create-checkout-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
      },
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      toast(data.error || "Couldn't start checkout");
    }
  } catch (err) {
    toast("Couldn't start checkout");
  }
}

(function checkPremiumRedirect() {
  const params = new URLSearchParams(location.search);
  if (params.get("premium") === "ok") {
    toast("Payment complete! Activating premium…");
    history.replaceState({}, "", location.pathname);
  } else if (params.get("premium") === "cancelado") {
    toast("Payment canceled");
    history.replaceState({}, "", location.pathname);
  }
})();

$("#btn-upload-submit").addEventListener("click", async () => {
  if (!selectedFile || !cropState) return toast("Choose a photo first");
  const btn = $("#btn-upload-submit");
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const blob = await renderCroppedBlob();
    const path = `${currentUser.id}/${Date.now()}.jpg`;

    const { error: uploadError } = await supa.storage
      .from("outfit-photos")
      .upload(path, blob, { contentType: "image/jpeg" });
    if (uploadError) throw uploadError;

    const affiliateLink = $("#affiliate-input").value.trim();
    const { error: rpcError } = await supa.rpc("create_post", {
      p_image_path: path,
      p_affiliate_link: affiliateLink || null,
    });
    if (rpcError) {
      // clean up the uploaded file if the post couldn't be created
      await supa.storage.from("outfit-photos").remove([path]);
      if (/DAILY_LIMIT_REACHED/.test(rpcError.message)) {
        throw new Error("You've already published today's free photo");
      }
      throw rpcError;
    }

    toast("Published! It's in the deck now.");
    resetCropUI();
    $("#affiliate-input").value = "";
    loadQuota();
  } catch (err) {
    toast(err.message || "Couldn't publish");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// ---------- ranking ----------
async function loadRanking() {
  const list = $("#ranking-list");
  list.innerHTML = '<div class="spinner" style="border-top-color:var(--primary);border-color:rgba(108,92,231,0.25)"></div>';
  const { data, error } = await supa.rpc("get_ranking", { p_limit: 50 });
  if (error || !data || data.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="big-emoji">&#9733;</span>Not enough votes yet.</div>`;
    return;
  }
  list.innerHTML = data
    .map((post, i) => {
      const imgUrl = PUBLIC_BUCKET_URL + post.image_path;
      return `
        <div class="rank-row">
          <div class="rank-num">${i + 1}</div>
          <img class="rank-thumb" src="${imgUrl}" alt="fit" />
          <div class="rank-meta">
            <div class="name">Fit #${i + 1}</div>
            <div class="likes">${post.likes_count} ${post.likes_count === 1 ? "like" : "likes"}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

// ---------- session ----------
supa.auth.onAuthStateChange((event, session) => {
  currentUser = session ? session.user : null;
  if (currentUser) {
    hide($("#screen-auth"));
    show($("#bottom-nav"));
    goScreen("deck");
  } else {
    show($("#screen-auth"));
    hide($("#bottom-nav"));
    ["deck", "upload", "ranking"].forEach((s) => hide($(`#screen-${s}`)));
  }
});
