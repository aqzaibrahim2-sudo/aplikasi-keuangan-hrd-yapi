import { createClient } from '@supabase/supabase-js';

// Menggunakan Environment Variables Vercel
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const update = req.body;

  try {
    // 1. Cek apakah ada pesan bergambar (Foto Nota) dari Telegram
    if (update && update.message && update.message.photo) {
      const chatId = update.message.chat.id;
      const groupTitle = update.message.chat.title || update.message.from.first_name || 'Grup Telegram';
      const photos = update.message.photo;
      const fileId = photos[photos.length - 1].file_id; // Foto resolusi tertinggi

      // 2. Ambil URL file dari Telegram Bot API
      const fileRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await fileRes.json();

      if (!fileData.ok) {
        throw new Error('Gagal mengambil file dari Telegram API');
      }

      const filePath = fileData.result.file_path;
      const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

      // 3. Eksekusi OCR (Gunakan fungsi OCR bawaan/lama yang terbukti jalan)
      const ocrResult = await processOCR(imageUrl);

      const txDateStr = ocrResult.date || new Date().toISOString().split('T')[0];
      const txAmount = parseFloat(ocrResult.totalAmount || ocrResult.amount || 0);
      const txDescription = ocrResult.merchantName 
        ? `${ocrResult.merchantName} - ${ocrResult.items || 'Nota Telegram'}` 
        : (ocrResult.description || 'Nota Pembelian Telegram');
      const txTime = ocrResult.time || new Date().toTimeString().split(' ')[0];

      // Format MM/YYYY
      const dateParts = txDateStr.split('-');
      const monthYear = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[0]}` : '-';

      // 4. Logika Validasi Backdate (> 3 Bulan)
      const txDate = new Date(txDateStr);
      const today = new Date();
      const monthDiff = (today.getFullYear() - txDate.getFullYear()) * 12 + (today.getMonth() - txDate.getMonth());

      let txStatus = 'verified';
      if (monthDiff > 3) {
        txStatus = 'pending_review';
      }

      // 5. Simpan Data ke Tabel 'transactions' (Database Baru)
      const { error: dbError } = await supabase.from('transactions').insert([
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
          signed_amount: -txAmount, // Nilai minus untuk Kas Keluar
          image_url: imageUrl,
          input_method: 'telegram',
          status: txStatus
        }
      ]);

      if (dbError) {
        console.error('Database Error:', dbError);
        throw dbError;
      }

      // 6. Kirim Pesan Konfirmasi Balasan ke Telegram (Format Lama yang Stabil)
      let replyMessage = `✅ *Nota Berhasil Dicatat!*\n\n` +
        `📍 *Sumber:* ${groupTitle}\n` +
        `📅 *Tanggal:* ${txDateStr}\n` +
        `💰 *Nominal:* Rp ${txAmount.toLocaleString('id-ID')}\n` +
        `📝 *Uraian:* ${txDescription}`;

      if (txStatus === 'pending_review') {
        replyMessage += `\n\n⚠️ *Catatan:* Transaksi ini terdeteksi _backdate_ (> 3 bulan) dan masuk antrean verifikasi Admin di Dashboard.`;
      }

      await sendTelegramMessage(chatId, replyMessage);
    }
  } catch (err) {
    console.error('Error Webhook Execution:', err);
    // Kirim notifikasi error ke pengguna Telegram agar mengetahui jika ada kendala
    if (update && update.message && update.message.chat) {
      await sendTelegramMessage(update.message.chat.id, '❌ Terjadi kesalahan saat memproses nota. Silakan coba kirim ulang foto nota.');
    }
  }

  return res.status(200).json({ status: 'ok' });
}

// Helper Pengiriman Pesan Telegram (Stabil)
async function sendTelegramMessage(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    console.error('Gagal mengirim pesan Telegram:', err);
  }
}

// Fungsi OCR (Pertahankan implementasi OCR lama/eksisting Anda di sini)
async function processOCR(imageUrl) {
  // Jika Anda sudah memiliki API OCR eksternal (seperti Mindee/Google Vision/Tesseract),
  // masukkan fungsi pemanggil OCR lama Anda di sini.
  return {
    date: new Date().toISOString().split('T')[0],
    merchantName: 'Toko Telegram',
    items: 'Nota Belanja',
    totalAmount: 0,
    time: '12:00:00'
  };
}
