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
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

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

    // 4. Analisis Gambar Menggunakan DeepSeek Vision API
    const base64Image = Buffer.from(imgBuffer).toString('base64');
    
    const promptText = `Analisis foto nota/struk belanja ini (baik cetak maupun tulisan tangan manual).
Ekstrak data berikut dan kembalikan HANYA format JSON tanpa markdown / codeblock:
{
  "description": "Nama toko/cabang/penjual atau ringkasan singkat belanjaan",
  "amount": 180000,
  "raw_text": "Tuliskan seluruh teks yang berhasil terbaca dari nota ini"
}

Catatan Penting:
- "amount" HARUS berupa angka murni (integer) tanpa titik/koma, mewakili Total Harga / Total Pembayaran akhir.
- Jika "description" tidak ada nama toko, buatkan ringkasan singkat isi nota.`;

    const deepseekRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ]
          }
        ]
      })
    });

    const deepseekData = await deepseekRes.json();
    
    let description = 'Nota Belanja Telegram';
    let amount = 0;
    let rawText = '';

    if (deepseekData.choices && deepseekData.choices[0]?.message?.content) {
      const responseText = deepseekData.choices[0].message.content.trim();
      rawText = responseText;

      const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      
      try {
        const parsed = JSON.parse(cleanJson);
        if (parsed.description) description = parsed.description;
        if (parsed.amount) amount = parseInt(parsed.amount, 10) || 0;
        if (parsed.raw_text) rawText = parsed.raw_text;
      } catch (e) {
        console.error('Gagal parse JSON dari DeepSeek:', e);
      }
    } else {
      rawText = JSON.stringify(deepseekData);
    }

    const now = new Date();
    const currentDate = now.toISOString().split('T')[0];
    const currentTime = now.toTimeString().split(' ')[0].substring(0, 5);

    // 5. Simpan Hasil ke Database Supabase
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

    return res.status(200).json({ success: true, message: 'Berhasil diproses oleh DeepSeek Vision!' });
  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(200).json({ error: error.message });
  }
}
