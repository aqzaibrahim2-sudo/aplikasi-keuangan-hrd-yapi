import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Gunakan Service Role Key untuk akses backend Telegram
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const update = req.body;

  // Cek jika ada pesan berupa foto
  if (update.message && update.message.photo) {
    const chatId = update.message.chat.id;
    const groupTitle = update.message.chat.title || update.message.from.first_name || 'Grup Telegram';
    const photos = update.message.photo;
    const fileId = photos[photos.length - 1].file_id; // Ambil foto resolusi tertinggi

    try {
      // 1. Dapatkan URL File Foto dari Telegram Bot API
      const fileRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await fileRes.json();
      const filePath = fileData.result.file_path;
      const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

      // 2. Jalankan OCR (pembacaan teks nota via OCR API / Vision Service)
      // (Contoh mock data hasil OCR, sesuaikan dengan OCR engine yang Anda gunakan)
      const ocrResult = await processOCR(imageUrl); 
      
      const txDateStr = ocrResult.date || new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD
      const txAmount = ocrResult.totalAmount || 0;
      const txDescription = ocrResult.merchantName ? `${ocrResult.merchantName} - ${ocrResult.items}` : 'Pembelian Nota Telegram';
      const txTime = ocrResult.time || null;

      // Format Bulan / Tahun (MM/YYYY)
      const [year, month] = txDateStr.split('-');
      const monthYear = `${month}/${year}`;

      // 3. Logika Validasi Backdate (Pengecekan Selisih Bulan)
      const txDate = new Date(txDateStr);
      const today = new Date();
      
      // Hitung selisih bulan
      const monthDiff = (today.getFullYear() - txDate.getFullYear()) * 12 + (today.getMonth() - txDate.getMonth());

      let initialStatus = 'verified';
      if (monthDiff > 3) {
        initialStatus = 'pending_review'; // Backdate > 3 bulan masuk antrean review
      }

      // 4. Simpan ke Database Supabase
      const { data, error } = await supabase.from('transactions').insert([
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
          signed_amount: -txAmount, // Kas Keluar bernilai negatif
          image_url: imageUrl,
          input_method: 'telegram',
          status: initialStatus
        }
      ]);

      if (error) throw error;

      // 5. Kirim Balasan Konfirmasi ke Telegram
      let replyMessage = `✅ *Nota Berhasil Dicatat!*\n\n` +
        `📍 *Sumber:* ${groupTitle}\n` +
        `📅 *Tanggal:* ${txDateStr}\n` +
        `💰 *Nominal:* Rp ${txAmount.toLocaleString('id-ID')}\n` +
        `📝 *Uraian:* ${txDescription}\n`;

      if (initialStatus === 'pending_review') {
        replyMessage += `\n⚠️ *Catatan:* Transaksi ini terdeteksi _backdate_ (> 3 bulan) dan membutuhkan verifikasi Admin di Dashboard.`;
      }

      await sendTelegramMessage(chatId, replyMessage);

    } catch (err) {
      console.error('Error Webhook:', err);
      await sendTelegramMessage(chatId, '❌ Gagal memproses nota. Pastikan foto nota terlihat jelas.');
    }
  }

  return res.status(200).json({ status: 'ok' });
}

// Helper untuk mengirim pesan Telegram
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

// Mock fungsi OCR (Ganti dengan integrasi OCR Anda)
async function processOCR(imageUrl) {
  // Contoh return mock OCR
  return {
    date: new Date().toISOString().split('T')[0],
    merchantName: 'Toko/Kasir Telegram',
    items: 'Belanja Operasional',
    totalAmount: 50000,
    time: '14:30'
  };
}
