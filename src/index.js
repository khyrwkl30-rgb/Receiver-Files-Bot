
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
        env.WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response("OK");
      } catch (error) {
        console.error("Bot error:", error);
        return new Response("Internal error", { status: 500 });
      }
    }

    return new Response("Receiver Files Store is running");
  }
};

async function tg(env, method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    console.error("Telegram API error:", method, result);
  }

  return result;
}

async function say(env, chatId, text, keyboard) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(keyboard ? { reply_markup: keyboard } : {})
  });
}

async function answer(env, callbackId, text = "") {
  return tg(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text } : {})
  });
}

async function getRequest(env, id) {
  return env.DB.prepare(
    "SELECT * FROM requests WHERE id = ?"
  ).bind(id).first();
}

async function setAdminState(env, adminId, action, requestId) {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO admin_state
     (admin_id, action, request_id) VALUES (?, ?, ?)`
  ).bind(adminId, action, requestId).run();
}

async function clearAdminState(env, adminId) {
  return env.DB.prepare(
    "DELETE FROM admin_state WHERE admin_id = ?"
  ).bind(adminId).run();
}

async function handleUpdate(update, env) {
  const adminId = String(env.ADMIN_ID);

  if (update.callback_query) {
    await handleCallback(update.callback_query, env, adminId);
    return;
  }

  const message = update.message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const isAdmin = chatId === adminId;

  // أوامر البداية
  if (message.text === "/start") {
    if (isAdmin) {
      await say(env, chatId, "لوحة الإدارة جاهزة. الطلبات الجديدة ستصلك هنا.");
    } else {
      await say(
        env,
        chatId,
        "أهلاً بك في متجر ملفات الرسيفر ❤️\nاختار الخدمة المطلوبة:",
        {
          inline_keyboard: [
            [{ text: "سوفت وير", callback_data: "service|software" }],
            [{ text: "ملف قنوات", callback_data: "service|channels" }]
          ]
        }
      );
    }
    return;
  }

  // استقبال سعر من الإدارة
  if (isAdmin && message.text) {
    const state = await env.DB.prepare(
      "SELECT action, request_id FROM admin_state WHERE admin_id = ?"
    ).bind(adminId).first();

    if (state?.action === "price") {
      const price = Number(message.text.trim());

      if (!Number.isFinite(price) || price <= 0) {
        await say(env, adminId, "اكتب سعرًا صحيحًا بالأرقام.");
        return;
      }

      const order = await getRequest(env, state.request_id);

      if (!order || order.status !== "new") {
        await clearAdminState(env, adminId);
        await say(env, adminId, "الطلب غير موجود أو لم يعد في انتظار السعر.");
        return;
      }

      await env.DB.prepare(
        "UPDATE requests SET price = ?, status = 'priced' WHERE id = ?"
      ).bind(price, state.request_id).run();

      await clearAdminState(env, adminId);

      await say(
        env,
        order.chat_id,
        `تم تحديد سعر طلبك: ${price} جنيه.\nهل توافق على السعر؟`,
        {
          inline_keyboard: [[
            { text: "أوافق على السعر", callback_data: `accept|${state.request_id}` },
            { text: "أرفض السعر", callback_data: `decline|${state.request_id}` }
          ]]
        }
      );

      await say(env, adminId, "تم إرسال السعر للعميل.");
      return;
    }

    if (state?.action === "file") {
      await say(env, adminId, "ارفع الملف كـ Document، وليس كنص.");
      return;
    }
  }

  // الإدارة ترفع الملف بعد تأكيد الدفع
  if (isAdmin && message.document) {
    const state = await env.DB.prepare(
      "SELECT action, request_id FROM admin_state WHERE admin_id = ?"
    ).bind(adminId).first();

    if (state?.action === "file") {
      const order = await getRequest(env, state.request_id);

      if (!order || order.status !== "awaiting_file") {
        await clearAdminState(env, adminId);
        await say(env, adminId, "الطلب غير موجود أو ليس في انتظار الملف.");
        return;
      }

      const sent = await tg(env, "sendDocument", {
        chat_id: order.chat_id,
        document: message.document.file_id,
        caption: "تم تأكيد الدفع وإرسال الملف. شكرًا لطلبك ❤️"
      });

      if (sent.ok) {
        await env.DB.prepare(
          "UPDATE requests SET status = 'completed', file_id = ? WHERE id = ?"
        ).bind(message.document.file_id, state.request_id).run();

        await clearAdminState(env, adminId);
        await say(env, adminId, "تم إرسال الملف للعميل بنجاح.");
      } else {
        await say(env, adminId, "لم ينجح إرسال الملف. حاول رفعه مرة أخرى.");
      }
      return;
    }
  }

  // استقبال صورة من العميل
  if (!isAdmin && message.photo) {
    const photo = message.photo[message.photo.length - 1].file_id;

    // هل العميل أرسل إيصال تحويل؟
    const receiptOrder = await env.DB.prepare(
      `SELECT * FROM requests
       WHERE chat_id = ? AND status = 'accepted'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(chatId).first();

    if (receiptOrder) {
      await env.DB.prepare(
        "UPDATE requests SET receipt_id = ?, status = 'payment_review' WHERE id = ?"
      ).bind(photo, receiptOrder.id).run();

      await say(env, chatId, "وصل إيصال التحويل، وسيتم مراجعته من الإدارة.");

      await tg(env, "sendPhoto", {
        chat_id: adminId,
        photo,
        caption:
          `إيصال تحويل للطلب ${receiptOrder.id}\n` +
          `السعر: ${receiptOrder.price} جنيه\n` +
          `راجع الإيصال قبل تأكيد الدفع.`,
        reply_markup: {
          inline_keyboard: [
            [{ text: "تأكيد الدفع", callback_data: `confirm|${receiptOrder.id}` }],
            [{ text: "رفض الإيصال", callback_data: `reject|${receiptOrder.id}` }]
          ]
        }
      });
      return;
    }

    // هل العميل أرسل صورة معلومات الرسيفر؟
    const deviceOrder = await env.DB.prepare(
      `SELECT * FROM requests
       WHERE chat_id = ? AND status = 'waiting_photo'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(chatId).first();

    if (deviceOrder) {
      await env.DB.prepare(
        "UPDATE requests SET model = ?, status = 'new' WHERE id = ?"
      ).bind(photo, deviceOrder.id).run();

      await say(env, chatId, "وصلت صورة معلومات الرسيفر ❤️\nسيتم مراجعة طلبك وتحديد السعر.");

      const serviceName =
        deviceOrder.service === "software" ? "سوفت وير" : "ملف قنوات";

      await say(
        env,
        adminId,
        `طلب جديد رقم ${deviceOrder.id}\nالخدمة: ${serviceName}\nالعميل: ${chatId}`,
        {
          inline_keyboard: [[
            { text: "تحديد السعر", callback_data: `price|${deviceOrder.id}` }
          ]]
        }
      );

      await tg(env, "sendPhoto", {
        chat_id: adminId,
        photo,
        caption: `صورة معلومات الرسيفر للطلب ${deviceOrder.id}`
      });
      return;
    }

    await say(env, chatId, "ابدأ بالضغط على /start واختار الخدمة أولاً.");
    return;
  }

  // التعامل مع أنواع رسائل غير متوقعة
  if (!isAdmin && message.document) {
    await say(env, chatId, "من فضلك أرسل صورة معلومات الرسيفر أو صورة إيصال التحويل حسب حالة طلبك.");
  }
}

async function handleCallback(callback, env, adminId) {
  const data = callback.data || "";
  const chatId = String(callback.message.chat.id);
  const isAdmin = chatId === adminId;
  const [action, idOrService] = data.split("|");

  await answer(env, callback.id);

  // اختيار الخدمة من العميل
  if (action === "service" && !isAdmin) {
    if (!["software", "channels"].includes(idOrService)) return;

    const existing = await env.DB.prepare(
      `SELECT id FROM requests
       WHERE chat_id = ? AND status IN
       ('waiting_photo', 'new', 'priced', 'accepted', 'payment_review', 'awaiting_file')
       LIMIT 1`
    ).bind(chatId).first();

    if (existing) {
      await say(env, chatId, "لديك طلب قائم بالفعل. أكمل الطلب الحالي أولاً.");
      return;
    }

    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO requests
       (id, chat_id, service, status, created_at)
       VALUES (?, ?, ?, 'waiting_photo', ?)`
    ).bind(id, chatId, idOrService, new Date().toISOString()).run();

    await say(
      env,
      chatId,
      "من فضلك أرسل صورة معلومات الرسيفر التي يظهر فيها الموديل والإصدار 📷"
    );
    return;
  }

  const requestId = idOrService;
  const order = await getRequest(env, requestId);

  if (!order) {
    await say(env, chatId, "الطلب غير موجود.");
    return;
  }

  // العميل يقبل السعر
  if (action === "accept" && !isAdmin && String(order.chat_id) === chatId) {
    if (order.status !== "priced") {
      await say(env, chatId, "هذا العرض لم يعد متاحًا.");
      return;
    }

    await env.DB.prepare(
      "UPDATE requests SET status = 'accepted' WHERE id = ?"
    ).bind(requestId).run();

    await say(
      env,
      chatId,
      `تم قبول السعر: ${order.price} جنيه.\n` +
      `حوّل المبلغ إلى رقم الدفع التالي:\n${env.PAYMENT_NUMBER || "يرجى التواصل مع الإدارة لمعرفة رقم الدفع"}\n\n` +
      "بعد التحويل، أرسل صورة إيصال التحويل هنا."
    );

    await say(env, adminId, `العميل قبل السعر للطلب ${requestId}.`);
    return;
  }

  // العميل يرفض السعر
  if (action === "decline" && !isAdmin && String(order.chat_id) === chatId) {
    if (order.status !== "priced") return;

    await env.DB.prepare(
      "UPDATE requests SET status = 'declined' WHERE id = ?"
    ).bind(requestId).run();

    await say(env, chatId, "تم رفض السعر. شكرًا لك.");
    await say(env, adminId, `العميل رفض السعر للطلب ${requestId}.`);
    return;
  }

  // الإدارة تحدد السعر
  if (action === "price" && isAdmin) {
    if (order.status !== "new") {
      await say(env, adminId, "هذا الطلب ليس في انتظار تحديد السعر.");
      return;
    }

    await setAdminState(env, adminId, "price", requestId);
    await say(env, adminId, `اكتب سعر الطلب ${requestId} بالجنيه.`);
    return;
  }

  // الإدارة تؤكد استلام التحويل
  if (action === "confirm" && isAdmin) {
    if (order.status !== "payment_review") {
      await say(env, adminId, "هذا الطلب ليس في انتظار مراجعة إيصال.");
      return;
    }

    await env.DB.prepare(
      "UPDATE requests SET status = 'awaiting_file' WHERE id = ?"
    ).bind(requestId).run();

    await setAdminState(env, adminId, "file", requestId);

    await say(env, order.chat_id, "تم تأكيد الدفع بنجاح ❤️\nسيتم إرسال الملف إليك الآن.");
    await say(env, adminId, `تم تأكيد الدفع للطلب ${requestId}.\nارفع الملف الآن كـ Document.`);
    return;
  }

  // الإدارة ترفض الإيصال
  if (action === "reject" && isAdmin) {
    if (order.status !== "payment_review") {
      await say(env, adminId, "هذا الطلب ليس في انتظار مراجعة إيصال.");
      return;
    }

    await env.DB.prepare(
      "UPDATE requests SET status = 'accepted', receipt_id = NULL WHERE id = ?"
    ).bind(requestId).run();

    await say(
      env,
      order.chat_id,
      "تعذر تأكيد الإيصال. من فضلك راجع التحويل وأرسل صورة واضحة للإيصال مرة أخرى."
    );

    await say(env, adminId, `تم رفض إيصال الطلب ${requestId}.`);
    return;
  }
}
