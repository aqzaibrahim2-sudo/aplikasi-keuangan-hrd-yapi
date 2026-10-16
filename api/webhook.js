export default async function handler(req, res) {
  // Telegram akan melakukan check ping / POST
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Webhook active and ready!' });
  }

  try {
    const update = req.body;
    const message = update.message || update.edited_message;

    // Jika bukan pesan atau tidak ada foto, cukup balas HTTP 200 OK agar Telegram senang
    if (!message || !message.photo) {
      return res.status(200).json({ message: 'Bukan foto, diabaikan.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const OCR_API_KEY = process.env.OCR_API_KEY;

    const groupName = message.chat.title || `Grup ${message.chat.id}`;
    
    // Ambil resolusi foto tertinggi
    const photo = message.photo[message.photo.length - 1];
    const fileId = photo.file_id;

    // 1. Ambil File Path dari Telegram
    const tgFileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const tgFileData = await tgFileRes.json();
    
    if (!tgFileData.ok) {
      throw new Error('Gagal mengambil file info dari Telegram');
    }

    const filePath = tgFileData.result.file_path;
    const telegramImageUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    // 2. Unduh Gambar
    const imgFetch = await fetch(telegramImageUrl);
    const imgBuffer = await imgFetch.arrayBuffer();

    // 3. Upload Gambar ke Supabase Storage via REST API Direct
    const fileName = `receipt_${Date.now()}.jpg`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/receipts/${fileName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'image/jpeg'
      },
      body: imgBuffer
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Upload Supabase Storage Gagal: ${errText}`);
    }

    const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/receipts/${fileName}`;

    // 4. Panggil API OCR.space
    const formData = new URLSearchParams();
    formData.append('apikey', OCR_API_KEY);
    formData.append('url', imageUrl);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('OCREngine', '2');

    const ocrRes = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    const ocrData = await ocrRes.json();
    let rawText = '';
    if (ocrData && ocrData.ParsedResults && ocrData.ParsedResults.length > 0) {
      rawText = ocrData.ParsedResults[0].ParsedText || '';
    }

    // Tanggal dan jam saat ini
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

    // 5. Simpan Data Transaksi ke Database Supabase via REST API
    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/receipts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        group_id: groupName,
        image_url: imageUrl,
        transaction_date: currentDate,
        transaction_time: currentTime,
        description: 'Nota Belanja Telegram',
        amount: 0,
        raw_text: rawText
      })
    });

    if (!dbRes.ok) {
      const dbErr = await dbRes.text();
      throw new Error(`Simpan DB Supabase Gagal: ${dbErr}`);
    }

    return res.status(200).json({ success: true, message: 'Berhasil diproses!' });
  } catch (error) {
    console.error('Webhook Error:', error);
    // Selalu kembalikan 200 agar Telegram tidak melakukan retry bertubi-tubi saat ada kesalahan
    return res.status(200).json({ error: error.message });
  }
}
