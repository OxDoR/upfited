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
// Delegamos el click del link de cambio de modo (el nodo <a> se reemplaza cada vez con innerHTML)
$("#auth-switch-text").addEventListener("click", (e) => {
  if (e.target.id !== "auth-switch-link") return;
  e.preventDefault();
  authMode = authMode === "signin" ? "signup" : "signin";
  if (authMode === "signup") {
    $("#auth-title").textContent = "Crea tu cuenta";
    $("#auth-sub").textContent = "Sube tu primer fit en un momento.";
    $("#btn-auth-submit").textContent = "Crear cuenta";
    $("#auth-switch-text").innerHTML = '¿Ya tienes cuenta? <a href="#" id="auth-switch-link">Entrar</a>';
  } else {
    $("#auth-title").textContent = "Vota el fit";
    $("#auth-sub").textContent = "Sube tu look. Que decida la gente.";
    $("#btn-auth-submit").textContent = "Entrar";
    $("#auth-switch-text").innerHTML = '¿No tienes cuenta? <a href="#" id="auth-switch-link">Crear cuenta</a>';
  }
});

$("#btn-auth-submit").addEventListener("click", async () => {
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || !password) return toast("Rellena correo y contraseña");

  const btn = $("#btn-auth-submit");
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    if (authMode === "signup") {
      const { error } = await supa.auth.signUp({ email, password });
      if (error) throw error;
      toast("Cuenta creada. ¡Bienvenida/o!");
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    toast(traducirErrorAuth(err.message));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

function traducirErrorAuth(msg) {
  if (/already registered/i.test(msg)) return "Ese correo ya tiene cuenta";
  if (/invalid login/i.test(msg)) return "Correo o contraseña incorrectos";
  if (/password/i.test(msg) && /6/.test(msg)) return "La contraseña necesita al menos 6 caracteres";
  return msg;
}

$("#premium-pill").addEventListener("click", async () => {
  if (confirm("¿Cerrar sesión?")) {
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
    stage.innerHTML = `<div class="empty-state"><span class="big-emoji">&#10005;</span>No se pudo cargar el mazo.</div>`;
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
    stage.innerHTML = `<div class="empty-state"><span class="big-emoji">&#9733;</span>Ya has visto todos los fits de hoy.<br>Vuelve más tarde.</div>`;
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
        ${post.affiliate_link ? `<a class="card-link" href="${post.affiliate_link}" target="_blank" rel="noopener">Comprar prendas →</a>` : ""}
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

// ---------- upload ----------
let selectedFile = null;

$("#upload-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    $("#upload-box").innerHTML = `<img src="${reader.result}" alt="preview" />`;
  };
  reader.readAsDataURL(file);
});

async function loadQuota() {
  const { data, error } = await supa
    .from("profiles")
    .select("posts_today, is_premium, last_post_date")
    .eq("id", currentUser.id)
    .single();

  const banner = $("#quota-banner");
  if (error || !data) {
    banner.textContent = "No se pudo comprobar tu cuota.";
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const postsToday = data.last_post_date === today ? data.posts_today : 0;

  if (data.is_premium) {
    banner.innerHTML = `<span>Cuenta <strong>premium</strong></span><span>Publicaciones ilimitadas</span>`;
  } else if (postsToday >= 1) {
    banner.innerHTML = `<span>Límite diario usado</span><span class="pill premium">Hazte premium</span>`;
  } else {
    banner.innerHTML = `<span>Foto gratis de hoy</span><strong>disponible</strong>`;
  }
}

function resizeImage(file, maxDim = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else if (height > maxDim) {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$("#btn-upload-submit").addEventListener("click", async () => {
  if (!selectedFile) return toast("Elige una foto primero");
  const btn = $("#btn-upload-submit");
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const blob = await resizeImage(selectedFile);
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
      // limpiar el archivo subido si el post no se pudo crear
      await supa.storage.from("outfit-photos").remove([path]);
      if (/DAILY_LIMIT_REACHED/.test(rpcError.message)) {
        throw new Error("Ya has publicado tu foto gratis de hoy");
      }
      throw rpcError;
    }

    toast("¡Publicado! Ya está en el mazo.");
    selectedFile = null;
    $("#upload-input").value = "";
    $("#upload-box").innerHTML = '<span class="big-emoji">&#9635;</span>Toca para elegir una foto';
    $("#affiliate-input").value = "";
    loadQuota();
  } catch (err) {
    toast(err.message || "No se pudo publicar");
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
    list.innerHTML = `<div class="empty-state"><span class="big-emoji">&#9733;</span>Todavía no hay votos suficientes.</div>`;
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
            <div class="likes">${post.likes_count} ${post.likes_count === 1 ? "me gusta" : "me gusta"}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

// ---------- sesión ----------
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
