import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const update = req.body;

  try {
    if (update && update.message && update.message.photo) {
      const chatId = update.message.chat.id;
      const groupTitle = update.message.chat.title || update.message.from.first_name || 'Grup Telegram';
      const photos = update.message.photo;
      const fileId = photos[photos.length - 1].file_id;

      // 1. Dapatkan URL Foto dari Telegram
      const fileRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await fileRes.json();

      if (!fileData.ok) throw new Error('Gagal mengambil file foto dari Telegram.');

      const filePath = fileData.result.file_path;
      const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

      // 2. OCR Menggunakan DeepSeek API
      const ocrData = await analyzeReceiptWithDeepSeek(imageUrl);

      const txDateStr = ocrData.date || new Date().toISOString().split('T')[0];
      const txAmount = parseFloat(ocrData.amount || 0);
      const txDescription = ocrData.description || 'Pembelian Nota Telegram';
      const txTime = ocrData.time || new Date().toTimeString().split(' ')[0];

      const [year, month] = txDateStr.split('-');
      const monthYear = (year && month) ? `${month}/${year}` : '-';

      // 3. Pengecekan Backdate (> 3 Bulan)
      const txDate = new Date(txDateStr);
      const today = new Date();
      const monthDiff = (today.getFullYear() - txDate.getFullYear()) * 12 + (today.getMonth() - txDate.getMonth());

      const txStatus = monthDiff > 3 ? 'pending_review' : 'verified';

      // 4. Simpan langsung ke Tabel `transactions` (Tabel Utama)
      const { error: txError } = await supabase.from('transactions').insert([
        {
          source: groupTitle,
          transaction_date: txDateStr,
          month_year: monthYear,
          transaction_time: txTime,
          type: 'Kas Keluar',
          description: txDescription,
          unit_price: txAmount,
          quantity: 1,
          unit: 'Paket',
          percentage: 100,
          amount: txAmount,
          signed_amount: -txAmount,
          image_url: imageUrl,
          input_method: 'telegram',
          status: txStatus
        }
      ]);

      if (txError) throw txError;

      // 5. Kirim Balasan Konfirmasi ke Telegram
      let replyMessage = `✅ *Nota Berhasil Dicatat!*\n\n` +
        `📍 *Sumber:* ${groupTitle}\n` +
        `📅 *Tanggal:* ${txDateStr}\n` +
        `💰 *Nominal:* Rp ${txAmount.toLocaleString('id-ID')}\n` +
        `📝 *Uraian:* ${txDescription}`;

      if (txStatus === 'pending_review') {
        replyMessage += `\n\n⚠️ *Catatan:* Transaksi terdeteksi _backdate_ (> 3 bulan) dan masuk antrean verifikasi Admin.`;
      }

      await sendTelegramMessage(chatId, replyMessage);
    }
  } catch (err) {
    console.error('Webhook Error:', err);
    if (update && update.message && update.message.chat) {
      await sendTelegramMessage(update.message.chat.id, '❌ Gagal memproses foto nota. Silakan coba kirim ulang.');
    }
  }

  return res.status(200).json({ status: 'ok' });
}

// Fungsi OCR dengan DeepSeek API
async function analyzeReceiptWithDeepSeek(imageUrl) {
  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: `Analisa foto nota transaksi berikut dari URL: ${imageUrl}. Ekstrak data dalam format JSON murni: {"date": "YYYY-MM-DD", "time": "HH:MM:SS", "description": "Nama toko & barang", "amount": 0}`
          }
        ],
        response_format: { type: 'json_object' }
      })
    });

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return JSON.parse(data.choices[0].message.content);
    }
  } catch (e) {
    console.error('DeepSeek OCR Error:', e);
  }

  return {
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().split(' ')[0],
    description: 'Nota Telegram',
    amount: 0
  };
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });
}
