export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Webhook active and ready!' });
  }

  try {
    const update = req.body;
    const message = update.message || update.edited_message;

    if (!message || !message.photo) {
      return res.status(200).json({ message: 'Bukan foto, diabaikan.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    const groupName = message.chat.title || `Grup ${message.chat.id}`;
    
    // Ambil foto dengan resolusi tertinggi
    const photo = message.photo[message.photo.length - 1];
    const fileId = photo.file_id;

    // 1. Ambil File Path dari Telegram
    const tgFileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const tgFileData = await tgFileRes.json();
    
    if (!tgFileData.ok) throw new Error('Gagal mengambil file info dari Telegram');

    const filePath = tgFileData.result.file_path;
    const telegramImageUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    // 2. Unduh Gambar
    const imgFetch = await fetch(telegramImageUrl);
    const imgBuffer = await imgFetch.arrayBuffer();

    // 3. Upload Gambar ke Supabase Storage
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

    // 4. Analisis Gambar Menggunakan Google Gemini Vision API
    const base64Image = Buffer.from(imgBuffer).toString('base64');
    
    const promptText = `Analisis foto nota/struk belanja ini (baik cetak maupun tulisan tangan manual).
Ekstrak dua data berikut dan kembalikan HANYA format JSON tanpa teks lain atau markdown codeblock:
{
  "description": "Nama toko/cabang/penjual atau ringkasan singkat barang belanjaan",
  "amount": 180000,
  "raw_text": "Tuliskan seluruh teks yang berhasil kamu baca dari nota ini"
}

Catatan:
- "amount" HARUS berupa angka murni (integer) tanpa titik/koma, mewakili Total Harga / Total Pembayaran akhir.
- Jika "description" tidak ditemukan nama toko, buat keterangan ringkas dari nota tersebut.`;

    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: promptText },
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: base64Image
                }
              }
            ]
          }
        ]
      })
    });

    const geminiData = await geminiRes.json();
    
    let description = 'Nota Belanja Telegram';
    let amount = 0;
    let rawText = '';

    if (geminiData.candidates && geminiData.candidates[0]?.content?.parts[0]?.text) {
      const responseText = geminiData.candidates[0].content.parts[0].text.trim();
      // Bersihkan pemformatan markdown jika Gemini mengembalikannya dalam triple backticks
      const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
      
      try {
        const parsed = JSON.parse(cleanJson);
        description = parsed.description || description;
        amount = parseInt(parsed.amount, 10) || 0;
        rawText = parsed.raw_text || responseText;
      } catch (e) {
        console.error('JSON Parse Error dari Gemini:', e);
        rawText = responseText;
      }
    }

    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

    // 5. Simpan Hasil Analisis AI ke Database Supabase
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
        description: description,
        amount: amount,
        raw_text: rawText
      })
    });

    if (!dbRes.ok) {
      const dbErr = await dbRes.text();
      throw new Error(`Simpan DB Supabase Gagal: ${dbErr}`);
    }

    return res.status(200).json({ success: true, message: 'Berhasil diproses oleh Gemini AI!' });
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(200).json({ error: error.message });
  }
}
