export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Receiver Files Store is running");
    }

    if (url.pathname === "/setup" && request.method === "GET") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"]
      });

      return Response.json(result);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        await handleUpdate(await request.json(), env);
        return new Response("OK");
      } catch (error) {
        console.error(error);
        return new Response("Error", { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }
};

async function tg(env, method, data) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );
  return r.json();
}

async function say(env, chat, text, keyboard) {
  return tg(env, "sendMessage", {
    chat_id: chat,
    text,
    ...(keyboard ? { reply_markup: keyboard } : {})
  });
}

async function photo(env, chat, file, caption, keyboard) {
  return tg(env, "sendPhoto", {
    chat_id: chat,
    photo: file,
    caption,
    ...(keyboard ? { reply_markup: keyboard } : {})
  });
}

async function document(env, chat, file, caption) {
  return tg(env, "sendDocument", {
    chat_id: chat,
    document: file,
    caption
  });
}

async function answer(env, id) {
  return tg(env, "answerCallbackQuery", {
    callback_query_id: id
  });
}

const kb = rows => ({ inline_keyboard: rows });

const admin = (env, id) =>
  String(id) === String(env.ADMIN_ID);

async function getOrder(env, id) {
  return env.DB.prepare(
    "SELECT * FROM orders WHERE id = ?"
  ).bind(id).first();
}

async function setting(env, key) {
  const r = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = ?"
  ).bind(key).first();
  return r?.value || "";
}

async function saveSetting(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).bind(key, value).run();
}

async function adminState(env) {
  return env.DB.prepare(
    "SELECT * FROM admin_state WHERE user_id = ?"
  ).bind(String(env.ADMIN_ID)).first();
}

async function setAdminState(env, action, orderId = null) {
  await env.DB.prepare(`
    INSERT INTO admin_state (user_id, order_id, action)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      order_id = excluded.order_id,
      action = excluded.action
  `).bind(String(env.ADMIN_ID), orderId, action).run();
}

async function clearAdminState(env) {
  await env.DB.prepare(
    "DELETE FROM admin_state WHERE user_id = ?"
  ).bind(String(env.ADMIN_ID)).run();
}

function customerMenu() {
  return kb([
    [{ text: "ملف قنوات", callback_data: "service|channels" }],
    [{ text: "سوفت وير", callback_data: "service|software" }],
    [{ text: "خدمة العملاء", callback_data: "service|support" }]
  ]);
}

function adminMenu() {
  return kb([
    [{ text: "الطلبات الجديدة", callback_data: "admin|new" }],
    [{ text: "كل الطلبات", callback_data: "admin|all" }],
    [{ text: "إرسال ملف لعميل", callback_data: "admin|send" }],
    [{ text: "المبيعات والإيرادات", callback_data: "admin|sales" }],
    [{ text: "إعدادات المتجر", callback_data: "admin|settings" }]
  ]);
}

async function handleUpdate(update, env) {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  if (update.message) {
    await handleMessage(update.message, env);
  }
}

async function handleMessage(m, env) {
  const id = String(m.chat.id);
  const isAdmin = admin(env, id);
  const text = (m.text || "").trim();

  if (text === "/start") {
    if (isAdmin) {
      return say(env, id, "لوحة المدير:", adminMenu());
    }
    return say(
      env,
      id,
      "أهلاً بك في متجر ملفات الرسيفر.\nاختار الخدمة:",
      customerMenu()
    );
  }

  if (isAdmin) {
    const state = await adminState(env);

    if (state?.action === "price") {
      const price = Number(text);

      if (!Number.isFinite(price) || price <= 0) {
        return say(env, id, "اكتب السعر بالأرقام بشكل صحيح.");
      }

      const order = await getOrder(env, state.order_id);

      if (!order || order.status !== "new") {
        await clearAdminState(env);
        return say(env, id, "الطلب غير موجود أو لم يعد جديداً.");
      }

      await env.DB.prepare(
        "UPDATE orders SET price = ?, status = 'priced' WHERE id = ?"
      ).bind(price, order.id).run();

      await clearAdminState(env);

      await say(
        env,
        order.user_id,
        `سعر طلبك رقم ${order.id} هو ${price} جنيه.\nهل توافق؟`,
        kb([[
          { text: "أوافق", callback_data: `accept|${order.id}` },
          { text: "إلغاء", callback_data: `decline|${order.id}` }
        ]])
      );

      return say(env, id, "تم إرسال السعر للعميل.");
    }

    if (state?.action === "payment_number") {
      if (text.length < 4) return say(env, id, "رقم التحويل غير صحيح.");
      await saveSetting(env, "payment_number", text);
      await clearAdminState(env);
      return say(env, id, "تم حفظ رقم التحويل.");
    }

    if (state?.action === "support") {
      const username = text.replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
        return say(env, id, "أرسل اسم مستخدم صحيحاً مثل support_name.");
      }
      await saveSetting(env, "support", username);
      await clearAdminState(env);
      return say(env, id, "تم حفظ حساب خدمة العملاء.");
    }

    if (state?.action === "send_file") {
      const order = await getOrder(env, state.order_id);

      if (!order || order.status !== "awaiting_file") {
        await clearAdminState(env);
        return say(env, id, "الطلب غير موجود أو لم يتم تأكيد دفعه.");
      }

      if (!m.document) {
        return say(env, id, "أرسل الملف كمستند Document.");
      }

      const sent = await document(
        env,
        order.user_id,
        m.document.file_id,
        `تم تسليم طلبك رقم ${order.id}. شكراً لك.`
      );

      if (sent.ok) {
        await env.DB.prepare(
          "UPDATE orders SET file_id = ?, status = 'completed' WHERE id = ?"
        ).bind(m.document.file_id, order.id).run();

        await clearAdminState(env);
        return say(env, id, "تم إرسال الملف للعميل بنجاح.");
      }

      return say(env, id, "تعذر إرسال الملف. حاول مرة أخرى.");
    }

    if (state?.action === "send_order") {
      const orderId = Number(text.replace("#", ""));
      const order = await getOrder(env, orderId);

      if (!order || order.status !== "awaiting_file") {
        return say(env, id, "رقم الطلب غير صحيح أو الدفع غير مؤكد.");
      }

      await setAdminState(env, "send_file", orderId);
      return say(env, id, `أرسل ملف الطلب رقم ${orderId} الآن.`);
    }
  }

  // العميل يكتب موديل الرسيفر
  if (!isAdmin) {
    const order = await env.DB.prepare(`
      SELECT * FROM orders
      WHERE user_id = ? AND status IN ('waiting_model','waiting_photo','accepted')
      ORDER BY id DESC LIMIT 1
    `).bind(id).first();

    if (order?.status === "waiting_model" && text) {
      await env.DB.prepare(
        "UPDATE orders SET model = ?, status = 'waiting_photo' WHERE id = ?"
      ).bind(text, order.id).run();

      return say(env, id, "ابعت صورة واضحة للرسيفر أو الملصق الموجود عليه.");
    }

    if (order?.status === "waiting_photo" && m.photo) {
      const fileId = m.photo[m.photo.length - 1].file_id;

      await env.DB.prepare(
        "UPDATE orders SET photo_id = ?, status = 'new' WHERE id = ?"
      ).bind(fileId, order.id).run();

      await say(env, id, `تم استلام طلبك رقم ${order.id}. انتظر تحديد السعر.`);

      await photo(
        env,
        env.ADMIN_ID,
        fileId,
        `طلب جديد رقم ${order.id}\nالخدمة: ${order.service}\nالموديل: ${order.model}\nالعميل: ${id}`,
        kb([[
          { text: "تحديد السعر", callback_data: `price|${order.id}` },
          { text: "رفض الطلب", callback_data: `reject_order|${order.id}` }
        ]])
      );

      return;
    }

    if (order?.status === "accepted" && m.photo) {
      const proof = m.photo[m.photo.length - 1].file_id;

      await env.DB.prepare(
        "UPDATE orders SET receipt_id = ?, status = 'payment_review' WHERE id = ?"
      ).bind(proof, order.id).run();

      await say(env, id, "وصل إيصال التحويل، وسيتم مراجعته.");

      return photo(
        env,
        env.ADMIN_ID,
        proof,
        `إيصال الطلب رقم ${order.id}\nالسعر: ${order.price} جنيه`,
        kb([[
          { text: "تأكيد الدفع", callback_data: `paid|${order.id}` },
          { text: "رفض الإيصال", callback_data: `unpaid|${order.id}` }
        ]])
      );
    }
  }

  if (isAdmin && m.text === "/start") {
    return say(env, id, "لوحة المدير:", adminMenu());
  }
}

async function handleCallback(q, env) {
  await answer(env, q.id);

  const id = String(q.message.chat.id);
  const isAdmin = admin(env, id);
  const [action, value] = (q.data || "").split("|");

  if (action === "service" && !isAdmin) {
    if (value === "support") {
      const username = await setting(env, "support");
      if (!username) return say(env, id, "خدمة العملاء غير مضبوطة حالياً.");
      return say(env, id, "تواصل مع خدمة العملاء:", kb([[
        { text: "خدمة العملاء", url: `https://t.me/${username}` }
      ]]));
    }

    if (!["channels", "software"].includes(value)) return;

    const active = await env.DB.prepare(`
      SELECT id FROM orders WHERE user_id = ?
      AND status IN ('waiting_model','waiting_photo','new','priced','accepted','payment_review','awaiting_file')
      LIMIT 1
    `).bind(id).first();

    if (active) return say(env, id, "عندك طلب قائم بالفعل. أكمله أولاً.");

    await env.DB.prepare(`
      INSERT INTO orders (user_id, service, status)
      VALUES (?, ?, 'waiting_model')
    `).bind(id, value).run();

    return say(env, id, "اكتب موديل الرسيفر بالتفصيل.");
  }

  if (action === "price" && isAdmin) {
    const order = await getOrder(env, Number(value));
    if (!order || order.status !== "new") return say(env, id, "الطلب غير متاح.");
    await setAdminState(env, "price", order.id);
    return say(env, id, `اكتب سعر الطلب رقم ${order.id} بالجنيه.`);
  }

  if (action === "accept" && !isAdmin) {
    const order = await getOrder(env, Number(value));
    if (!order || String(order.user_id) !== id || order.status !== "priced") return;
    await env.DB.prepare(
      "UPDATE orders SET status = 'accepted' WHERE id = ?"
    ).bind(order.id).run();

    const number = await setting(env, "payment_number");
    return say(
      env,
      id,
      `حوّل ${order.price} جنيه إلى رقم التحويل:\n${number || "تواصل مع خدمة العملاء لمعرفة الرقم"}\n\nثم أرسل صورة الإيصال هنا.`
    );
  }

  if (action === "decline" && !isAdmin) {
    const order = await getOrder(env, Number(value));
    if (!order || String(order.user_id) !== id || order.status !== "priced") return;
    await env.DB.prepare(
      "UPDATE orders SET status = 'declined' WHERE id = ?"
    ).bind(order.id).run();
    return say(env, id, "تم إلغاء الطلب.");
  }

  if (action === "paid" && isAdmin) {
    const order = await getOrder(env, Number(value));
    if (!order || order.status !== "payment_review") return;
    await env.DB.prepare(
      "UPDATE orders SET status = 'awaiting_file' WHERE id = ?"
    ).bind(order.id).run();
    await say(env, order.user_id, "تم تأكيد الدفع. سيتم إرسال الملف قريباً.");
    await setAdminState(env, "send_file", order.id);
    return say(env, id, `تم تأكيد الدفع. أرسل ملف الطلب ${order.id} الآن.`);
  }

  if (action === "unpaid" && isAdmin) {
    const order = await getOrder(env, Number(value));
    if (!order || order.status !== "payment_review") return;
    await env.DB.prepare(
      "UPDATE orders SET status = 'accepted', receipt_id = NULL WHERE id = ?"
    ).bind(order.id).run();
    return say(env, order.user_id, "لم نتمكن من تأكيد التحويل. أرسل إيصالاً واضحاً مرة أخرى.");
  }

  if (action === "reject_order" && isAdmin) {
    const order = await getOrder(env, Number(value));
    if (!order || order.status !== "new") return;
    await env.DB.prepare(
      "UPDATE orders SET status = 'rejected' WHERE id = ?"
    ).bind(order.id).run();
    await say(env, order.user_id, "نعتذر، تم رفض الطلب. يمكنك التواصل مع خدمة العملاء.");
    return say(env, id, `تم رفض الطلب ${order.id}.`);
  }

  if (action === "admin" && isAdmin) {
    if (value === "settings") {
      return say(env, id, "اختر الإعداد:", kb([
        [{ text: "تغيير رقم التحويل", callback_data: "setting|payment" }],
        [{ text: "تغيير خدمة العملاء", callback_data: "setting|support" }]
      ]));
    }

    if (value === "new" || value === "all") {
      const sql = value === "new"
        ? "SELECT * FROM orders WHERE status = 'new' ORDER BY id DESC LIMIT 20"
        : "SELECT * FROM orders ORDER BY id DESC LIMIT 20";

      const result = await env.DB.prepare(sql).all();
      if (!result.results?.length) return say(env, id, "لا توجد طلبات.");

      for (const o of result.results) {
        await say(
          env,
          id,
          `طلب #${o.id}\nالعميل: ${o.user_id}\nالخدمة: ${o.service}\nالموديل: ${o.model || "-"}\nالسعر: ${o.price || "-"}\nالحالة: ${o.status}`,
          o.status === "new" ? kb([[
            { text: "تحديد السعر", callback_data: `price|${o.id}` }
          ]]) : undefined
        );
      }
      return;
    }

    if (value === "send") {
      await setAdminState(env, "send_order");
      return say(env, id, "اكتب رقم الطلب الذي تريد إرسال ملفه.");
    }

    if (value === "sales") {
      const r = await env.DB.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(price),0) AS total
        FROM orders WHERE status = 'completed'
      `).first();

      return say(
        env,
        id,
        `الطلبات المسلّمة: ${r.count}\nإجمالي المبيعات: ${r.total} جنيه`
      );
    }
  }

  if (action === "setting" && isAdmin) {
    if (value === "payment") {
      await setAdminState(env, "payment_number");
      return say(env, id, "أرسل رقم التحويل الجديد.");
    }
    if (value === "support") {
      await setAdminState(env, "support");
      return say(env, id, "أرسل اسم مستخدم خدمة العملاء بدون @.");
    }
  }
        }
