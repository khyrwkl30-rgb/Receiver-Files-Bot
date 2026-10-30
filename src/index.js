// Receiver Files Bot - Cloudflare Worker
// Required: D1 binding DB
// Secrets: BOT_TOKEN, ADMIN_ID, WEBHOOK_SECRET
// Optional variable: PAYMENT_NUMBER

const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>طلب ملفات الرسيفر</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box}
body{margin:0;padding:22px;font-family:Arial,sans-serif;background:var(--tg-theme-bg-color,#111);color:var(--tg-theme-text-color,#fff)}
.card{max-width:520px;margin:auto;background:var(--tg-theme-secondary-bg-color,#222);padding:20px;border-radius:18px}
h2{margin-top:0}
label{display:block;margin:17px 0 8px}
select,input{width:100%;padding:14px;border-radius:10px;border:1px solid #777;background:var(--tg-theme-bg-color,#111);color:var(--tg-theme-text-color,#fff);font-size:16px}
button{width:100%;padding:15px;border:0;border-radius:12px;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff);font-size:17px;margin-top:20px}
small{opacity:.75}
.status{margin-top:15px;line-height:1.7}
</style>
</head>
<body>
<div class="card">
<h2>📡 متجر ملفات الرسيفر</h2>
<p>املأ البيانات وارفع صورة معلومات الجهاز، وسيصلك السعر بعد مراجعة الطلب.</p>
<form id="f">
<label>نوع الطلب</label>
<select id="service" required>
<option value="">اختر نوع الخدمة</option>
<option value="سوفت">سوفت رسيفر</option>
<option value="ملف قنوات">ملف قنوات</option>
</select>
<label>موديل الرسيفر</label>
<input id="model" maxlength="100" placeholder="مثال: Tiger T3000" required>
<label>صورة معلومات الجهاز</label>
<input id="photo" type="file" accept="image/jpeg,image/png,image/webp" required>
<small>صورة واضحة من صفحة معلومات الجهاز (بحد أقصى 5 ميجابايت).</small>
<button id="send" type="submit">إرسال الطلب</button>
<div class="status" id="status"></div>
</form>
</div>
<script>
const tg=window.Telegram.WebApp;
tg.ready();
tg.expand();

const form=document.getElementById('f');
const statusEl=document.getElementById('status');
const btn=document.getElementById('send');

form.addEventListener('submit',async e=>{
 e.preventDefault();
 const file=document.getElementById('photo').files[0];

 if(!tg.initData){
  statusEl.textContent='افتح الصفحة من زر البوت داخل تيليجرام.';
  return;
 }
 if(!file){
  statusEl.textContent='اختر صورة معلومات الجهاز.';
  return;
 }
 if(file.size>5*1024*1024){
  statusEl.textContent='حجم الصورة أكبر من 5 ميجابايت.';
  return;
 }

 btn.disabled=true;
 statusEl.textContent='جارٍ إرسال الطلب...';

 try{
  const dataUrl=await new Promise((resolve,reject)=>{
   const r=new FileReader();
   r.onload=()=>resolve(r.result);
   r.onerror=reject;
   r.readAsDataURL(file);
  });

  const res=await fetch('/api/order',{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   body:JSON.stringify({
    initData:tg.initData,
    service:document.getElementById('service').value,
    model:document.getElementById('model').value.trim(),
    image:dataUrl
   })
  });

  const out=await res.json();
  if(!res.ok) throw new Error(out.error||'تعذر إرسال الطلب');

  statusEl.textContent='✅ تم إرسال طلبك بنجاح. رقم الطلب: '+out.id;
  tg.HapticFeedback?.notificationOccurred('success');

 }catch(err){
  statusEl.textContent='❌ '+err.message;
  btn.disabled=false;
 }
});
</script>
</body>
</html>`;

async function tg(env, method, body) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body)
    }
  );

  const data = await r.json();

  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }

  return data.result;
}

async function sendText(env, chat_id, text, extra = {}) {
  return tg(env, "sendMessage", {chat_id, text, ...extra});
}

async function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const pairs = [...params.entries()].sort(([a],[b]) => a.localeCompare(b));
  const check = pairs.map(([k,v]) => `${k}=${v}`).join("\n");

  const enc = new TextEncoder();

  const key1 = await crypto.subtle.importKey(
    "raw",
    enc.encode("WebAppData"),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["sign"]
  );

  const secret = await crypto.subtle.sign(
    "HMAC",
    key1,
    enc.encode(botToken)
  );

  const key2 = await crypto.subtle.importKey(
    "raw",
    secret,
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key2,
    enc.encode(check)
  );

  const actual = [...new Uint8Array(digest)]
    .map(b=>b.toString(16).padStart(2,"0"))
    .join("");

  if (actual !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);

  if (!authDate || Date.now()/1000 - authDate > 86400) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"content-type":"application/json; charset=utf-8"}
  });
}

function isAdmin(update, env) {
  const from =
    update.callback_query?.from?.id ??
    update.message?.from?.id;

  return String(from) === String(env.ADMIN_ID);
}

async function handleUpdate(update, env, requestUrl) {
  const msg = update.message;
  const cb = update.callback_query;

  if (cb) {
    const [action,id] = (cb.data || "").split("|");

    const req = await env.DB
      .prepare("SELECT * FROM requests WHERE id=?")
      .bind(id)
      .first();

    if (!req) {
      await tg(env,"answerCallbackQuery",{
        callback_query_id:cb.id,
        text:"الطلب غير موجود"
      });
      return;
    }

    // موافقة العميل أو إلغاء السعر
    if (action === "accept" || action === "decline") {
      if (String(cb.from.id) !== String(req.chat_id)) {
        await tg(env,"answerCallbackQuery",{
          callback_query_id:cb.id,
          text:"هذا الزر ليس خاصًا بك",
          show_alert:true
        });
        return;
      }

      if (action === "accept") {
        await env.DB
          .prepare("UPDATE requests SET status='awaiting_payment' WHERE id=?")
          .bind(id)
          .run();

        await sendText(
          env,
          req.chat_id,
          `تمام، حوّل ${req.price} جنيه إلى: ${env.PAYMENT_NUMBER || "تواصل مع الإدارة لمعرفة رقم التحويل"}\nبعد التحويل أرسل صورة الإيصال هنا.`
        );

        await tg(env,"answerCallbackQuery",{
          callback_query_id:cb.id,
          text:"تم قبول السعر"
        });

      } else {
        await env.DB
          .prepare("UPDATE requests SET status='declined' WHERE id=?")
          .bind(id)
          .run();

        await sendText(
          env,
          req.chat_id,
          "تم إلغاء الطلب. يمكنك إرسال طلب جديد في أي وقت."
        );

        await tg(env,"answerCallbackQuery",{
          callback_query_id:cb.id,
          text:"تم إلغاء الطلب"
        });
      }

      return;
    }

    // أزرار المدير فقط
    if (!isAdmin(update, env)) {
      await tg(env,"answerCallbackQuery",{
        callback_query_id:cb.id,
        text:"غير مصرح",
        show_alert:true
      });
      return;
    }

    if (action === "price") {
      await env.DB
        .prepare("INSERT OR REPLACE INTO admin_state(admin_id,action,request_id) VALUES(?,?,?)")
        .bind(String(env.ADMIN_ID),"price",id)
        .run();

      await sendText(
        env,
        env.ADMIN_ID,
        `اكتب السعر للطلب #${id} في رسالة واحدة (بالجنيه).`
      );

    } else if (action === "paid") {
      await env.DB
        .prepare("UPDATE requests SET status='paid' WHERE id=?")
        .bind(id)
        .run();

      await sendText(
        env,
        req.chat_id,
        `✅ تم تأكيد وصول الدفع لطلبك رقم #${id}. جاري تجهيز الملف.`
      );

      await sendText(
        env,
        env.ADMIN_ID,
        `تم تأكيد الدفع للطلب #${id}. اضغط «إرسال الملف» بعد مراجعة التحويل.`
      );

    } else if (action === "file") {
      await env.DB
        .prepare("INSERT OR REPLACE INTO admin_state(admin_id,action,request_id) VALUES(?,?,?)")
        .bind(String(env.ADMIN_ID),"file",id)
        .run();

      await sendText(
        env,
        env.ADMIN_ID,
        `ابعت الملف الآن كـ Document للطلب #${id}.`
      );
    }

    await tg(env,"answerCallbackQuery",{
      callback_query_id:cb.id,
      text:"تم"
    });

    return;
  }

  if (!msg) return;

  // رسائل المدير
  if (String(msg.from?.id) === String(env.ADMIN_ID)) {
    const state = await env.DB
      .prepare("SELECT * FROM admin_state WHERE admin_id=?")
      .bind(String(env.ADMIN_ID))
      .first();

    // المدير يكتب السعر
    if (state?.action === "price" && msg.text && !msg.text.startsWith("/")) {
      const price = Number(msg.text.replace(/[^\d.]/g,""));

      if (!Number.isFinite(price) || price <= 0) {
        await sendText(env,env.ADMIN_ID,"اكتب سعرًا صحيحًا بالأرقام.");
        return;
      }

      const req = await env.DB
        .prepare("SELECT * FROM requests WHERE id=?")
        .bind(state.request_id)
        .first();

      if (!req) {
        await sendText(env,env.ADMIN_ID,"الطلب غير موجود.");
        return;
      }

      await env.DB
        .prepare("UPDATE requests SET price=?,status='awaiting_payment' WHERE id=?")
        .bind(String(price),state.request_id)
        .run();

      await env.DB
        .prepare("DELETE FROM admin_state WHERE admin_id=?")
        .bind(String(env.ADMIN_ID))
        .run();

      await sendText(
        env,
        req.chat_id,
        `💰 سعر طلبك رقم #${req.id} هو ${price} جنيه. هل توافق على السعر؟`,
        {
          reply_markup:{
            inline_keyboard:[[
              {text:"✅ موافق",callback_data:`accept|${req.id}`},
              {text:"❌ إلغاء",callback_data:`decline|${req.id}`}
            ]]
          }
        }
      );

      await sendText(
        env,
        env.ADMIN_ID,
        "تم إرسال السعر للعميل. بعد موافقته وتحويله، راجع الإيصال ثم اضغط «تأكيد الدفع» وبعدها «إرسال الملف»."
      );

      return;
    }

    // المدير يرسل الملف
    if (state?.action === "file" && msg.document) {
      const req = await env.DB
        .prepare("SELECT * FROM requests WHERE id=?")
        .bind(state.request_id)
        .first();

      if (!req) {
        await sendText(env,env.ADMIN_ID,"الطلب غير موجود.");
        return;
      }

      await tg(env,"sendDocument",{
        chat_id:req.chat_id,
        document:msg.document.file_id,
        caption:`✅ تم تسليم ملف طلبك رقم #${req.id}. شكرًا لثقتك بنا.`
      });

      await env.DB
        .prepare("UPDATE requests SET status='delivered' WHERE id=?")
        .bind(state.request_id)
        .run();

      await env.DB
        .prepare("DELETE FROM admin_state WHERE admin_id=?")
        .bind(String(env.ADMIN_ID))
        .run();

      await sendText(
        env,
        env.ADMIN_ID,
        `✅ تم تسليم الملف للعميل للطلب #${req.id}.`
      );

      return;
    }
  }

  // بداية البوت
  if (msg.text?.startsWith("/start")) {
    const url = new URL("/app",requestUrl).toString();

    await sendText(
      env,
      msg.chat.id,
      "أهلًا بك في متجر ملفات الرسيفر 📡\nاضغط الزر لطلب سوفت أو ملف قنوات.",
      {
        reply_markup:{
          inline_keyboard:[[
            {
              text:"🛒 ابدأ طلب جديد",
              web_app:{url}
            }
          ]]
        }
      }
    );

    return;
  }

  // تحويل صورة إيصال العميل للمدير للمراجعة اليدوية
  if (msg.photo && String(msg.from?.id) !== String(env.ADMIN_ID)) {
    await sendText(
      env,
      env.ADMIN_ID,
      `📥 وصلت صورة من العميل ${msg.from.id}. راجعها يدويًا من المحادثة.`
    );

    await tg(env,"forwardMessage",{
      chat_id:env.ADMIN_ID,
      from_chat_id:msg.chat.id,
      message_id:msg.message_id
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // صفحة الطلب
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/app")
    ) {
      return new Response(html,{
        headers:{"content-type":"text/html; charset=utf-8"}
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("OK");
    }

    // استقبال طلب جديد
    if (request.method === "POST" && url.pathname === "/api/order") {
      try {
        const body = await request.json();

        const user = await verifyInitData(
          body.initData || "",
          env.BOT_TOKEN
        );

        if (!user?.id) {
          return json({
            error:"تعذر التحقق من حساب تيليجرام. افتح النموذج من البوت."
          },401);
        }

        const service = String(body.service || "");
        const model = String(body.model || "").trim();

        if (
          !["سوفت","ملف قنوات"].includes(service) ||
          !model ||
          model.length > 100
        ) {
          return json({
            error:"راجع نوع الطلب وموديل الرسيفر."
          },400);
        }

        const match = String(body.image || "").match(
          /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/
        );

        if (!match) {
          return json({
            error:"الصورة غير صالحة. ارفع JPG أو PNG أو WEBP."
          },400);
        }

        const bytes = Uint8Array.from(
          atob(match[2]),
          c=>c.charCodeAt(0)
        );

        if (bytes.length > 5*1024*1024) {
          return json({
            error:"الصورة أكبر من 5 ميجابايت."
          },400);
        }

        const id = crypto.randomUUID().slice(0,8).toUpperCase();

        await env.DB
          .prepare("INSERT INTO requests(id,chat_id,service,model,status,created_at) VALUES(?,?,?,?,?,?)")
          .bind(
            id,
            String(user.id),
            service,
            model,
            "new",
            new Date().toISOString()
          )
          .run();

        const form = new FormData();

        form.append("chat_id",String(env.ADMIN_ID));
        form.append(
          "photo",
          new Blob([bytes],{type:match[1]}),
          "receiver-info"
        );

        form.append(
          "caption",
          `📥 طلب جديد #${id}\nالعميل: ${user.first_name || ""} (@${user.username || "بدون"})\nID: ${user.id}\nالخدمة: ${service}\nموديل الرسيفر: ${model}`
        );

        form.append(
          "reply_markup",
          JSON.stringify({
            inline_keyboard:[
              [
                {text:"💰 تحديد السعر",callback_data:`price|${id}`},
                {text:"✅ تأكيد الدفع",callback_data:`paid|${id}`}
              ],
              [
                {text:"📤 إرسال الملف",callback_data:`file|${id}`}
              ]
            ]
          })
        );

        const sent = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`,
          {
            method:"POST",
            body:form
          }
        );

        const result = await sent.json();

        if (!result.ok) {
          throw new Error(
            result.description || "فشل إرسال الطلب للإدارة"
          );
        }

        await sendText(
          env,
          String(user.id),
          `تم استلام طلبك رقم #${id} بنجاح. سنراجع البيانات ونرسل لك السعر قريبًا.`
        );

        return json({ok:true,id});

      } catch(e) {
        return json({
          error:e.message || "حدث خطأ غير متوقع."
        },500);
      }
    }

    // Webhook تيليجرام
    if (request.method === "POST" && url.pathname === "/webhook") {
      if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.WEBHOOK_SECRET
      ) {
        return new Response("Forbidden",{status:403});
      }

      try {
        await handleUpdate(
          await request.json(),
          env,
          url.origin
        );

        return new Response("OK");

      } catch(e) {
        return new Response("Webhook error: "+e.message,{
          status:500
        });
      }
    }

    return new Response("Not found",{status:404});
  }
};
