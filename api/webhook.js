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

    const chatId = message.chat.id;
    const messageId = message.message_id;
    const groupName = message.chat.title || `Grup ${chatId}`;
    
    // Helper balasan pesan Telegram
    const replyToTelegram = async (text) => {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          reply_to_message_id: messageId,
          text: text
        })
      });
    };

    // Ambil foto resolusi tertinggi
    const photo = message.photo[message.photo.length - 1];
    const fileId = photo.file_id;

    // 1. Ambil File Path dari Telegram
    const tgFileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const tgFileData = await tgFileRes.json();
    
    if (!tgFileData.ok) throw new Error('Gagal mengambil file info dari Telegram');

    const filePath = tgFileData.result.file_path;
    const telegramImageUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    // 2. Unduh Gambar ke Memori (Buffer Sementara) - BELUM UPLOAD KE STORAGE
    const imgFetch = await fetch(telegramImageUrl);
    const imgBuffer = await imgFetch.arrayBuffer();
    const base64Image = Buffer.from(imgBuffer).toString('base64');

    // 3. Analisis Gambar Menggunakan DeepSeek API
    const promptText = `Analisis foto bukti transaksi ini (bisa berupa nota cetak, nota tulis tangan, atau screenshot bukti transfer/QRIS/m-banking).
Ekstrak data berikut dan kembalikan HANYA format JSON valid tanpa markdown/codeblock:
{
  "description": "Nama toko/cabang atau keterangan transfer/QRIS",
  "amount": 180000,
  "transaction_date": "YYYY-MM-DD",
  "transaction_time": "HH:MM",
  "is_transfer_proof": true,
  "raw_text": "Tuliskan seluruh teks yang berhasil terbaca"
}

Aturan Penting:
1. "amount": Angka murni Total Bayar/Total Harga akhir.
2. "transaction_date": Format YYYY-MM-DD.
3. "transaction_time": Format HH:MM (24 jam).
4. "is_transfer_proof": Set true JIKA gambar ini adalah bukti transfer bank/m-banking/QRIS/struk ATM. Set false jika ini adalah nota/struk belanja asli dari toko.`;

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
    let isTransferProof = false;
    
    const now = new Date();
    let transactionDate = now.toISOString().split('T')[0];
    let transactionTime = now.toTimeString().split(' ')[0].substring(0, 5);

    if (deepseekData.choices && deepseekData.choices[0]?.message?.content) {
      const responseText = deepseekData.choices[0].message.content.trim();
      rawText = responseText;

      const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
      
      try {
        const parsed = JSON.parse(cleanJson);
        if (parsed.description) description = parsed.description;
        if (parsed.amount) amount = parseInt(parsed.amount, 10) || 0;
        if (parsed.transaction_date) transactionDate = parsed.transaction_date;
        if (parsed.transaction_time) transactionTime = parsed.transaction_time;
        if (parsed.is_transfer_proof !== undefined) isTransferProof = parsed.is_transfer_proof;
        if (parsed.raw_text) rawText = parsed.raw_text;
      } catch (e) {
        console.error('JSON Parse error');
      }
    } else {
      rawText = JSON.stringify(deepseekData);
    }

    // Normalisasi format tanggal
    if (transactionDate && /^\d{2}[-/\.]\d{2}[-/\.]\d{4}$/.test(transactionDate)) {
      const parts = transactionDate.split(/[-/\.]/);
      transactionDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    // --- 4. SISTEM ANTI DUPLIKASI GLOBAL (LINTAS GRUP) ---
    const checkDupRes = await fetch(`${SUPABASE_URL}/rest/v1/receipts?amount=eq.${amount}&transaction_date=eq.${transactionDate}&select=id,group_id,status,description`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      }
    });

    let existingRecords = [];
    if (checkDupRes.ok) {
      existingRecords = await checkDupRes.json();
    }

    let recordStatus = 'verified';

    if (existingRecords.length > 0) {
      if (isTransferProof) {
        // Jika bukti transfer, tandai pending_review dan LAnJUTKAN simpan gambar & data
        recordStatus = 'pending_review';
        await replyToTelegram(`⚠️ Transaksi Rp ${amount.toLocaleString('id-ID')} sudah tercatat sebelumnya. Bukti transfer/QRIS ini dimasukkan ke antrean pemeriksaan Admin.`);
      } else {
        // JIKA DUPLIKAT NOTA TOKO: TOLAK SEGERA DAN JANGAN UPLOAD KE STORAGE SUPABASE
        const recordedGroup = existingRecords[0].group_id || 'grup lain';
        await replyToTelegram(`❌ Gagal dicatat: Nota duplikat terdeteksi! Nota tanggal ${transactionDate} nominal Rp ${amount.toLocaleString('id-ID')} ini sudah pernah dimasukkan (tercatat di: ${recordedGroup}).`);
        
        return res.status(200).json({ 
          success: false, 
          message: `Nota duplikat ditolak tanpa di-upload ke Storage.` 
        });
      }
    }

    // --- 5. UPLOAD KE SUPABASE STORAGE (HANYA DILAKUKAN JIKA LOLOS DUPLIKASI) ---
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

    // 6. Simpan Hasil ke Database Supabase
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
        transaction_date: transactionDate,
        transaction_time: transactionTime,
        description: description,
        amount: amount,
        raw_text: rawText,
        status: recordStatus
      })
    });

    if (!dbRes.ok) {
      const dbErr = await dbRes.text();
      throw new Error(`Simpan DB Supabase Gagal: ${dbErr}`);
    }

    // Balasan jika berhasil dicatat normal
    if (recordStatus === 'verified') {
      await replyToTelegram(`✅ Berhasil dicatat!\nToko: ${description}\nNominal: Rp ${amount.toLocaleString('id-ID')}\nTanggal: ${transactionDate}`);
    }

    return res.status(200).json({ success: true, message: 'Diproses dengan sukses!' });

  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(200).json({ error: error.message });
  }
}
