import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OCR_API_KEY = process.env.OCR_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'Webhook is active!' });
  }

  try {
    const update = req.body;
    const message = update.message || update.edited_message;

    if (!message || !message.photo) {
      return res.status(200).json({ message: 'Bukan pesan foto, diabaikan.' });
    }

    const chatId = message.chat.id.toString();
    const groupName = message.chat.title || `Grup ${chatId}`;
    
    // Ambil foto dengan resolusi tertinggi
    const photos = message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileId = bestPhoto.file_id;

    // 1. Ambil URL file dari Telegram API
    const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) throw new Error('Gagal mengambil file dari Telegram');
    
    const filePath = fileData.result.file_path;
    const telegramFileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    // 2. Unduh gambar untuk diunggah ke Supabase Storage
    const imageRes = await fetch(telegramFileUrl);
    const imageBuffer = await imageRes.arrayBuffer();
    const fileName = `receipt_${Date.now()}.jpg`;

    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(fileName, imageBuffer, { contentType: 'image/jpeg' });

    if (uploadError) throw new Error('Gagal upload ke Supabase Storage: ' + uploadError.message);

    // Ambil Public URL gambar dari Supabase
    const { data: publicUrlData } = supabase.storage
      .from('receipts')
      .getPublicUrl(fileName);
    
    const imageUrl = publicUrlData.publicUrl;

    // 3. Proses OCR menggunakan OCR.space API
    const ocrFormData = new URLSearchParams();
    ocrFormData.append('apikey', OCR_API_KEY);
    ocrFormData.append('url', telegramFileUrl);
    ocrFormData.append('language', 'ind');
    ocrFormData.append('isOverlayRequired', 'false');
    ocrFormData.append('scale', 'true');
    ocrFormData.append('OCREngine', '2');

    const ocrRes = await fetch('https://api.parse.com/api/v1/parse/image', { // Alternatif endpoint atau URL resmi ocr.space
      method: 'POST',
      body: ocrFormData
    });
    
    // Gunakan fetch langsung ke API resmi ocr.space
    const ocrResponse = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      body: ocrFormData
    });
    const ocrResult = await ocrResponse.json();
    
    let rawText = '';
    if (ocrResult && ocrResult.ParsedResults && ocrResult.ParsedResults.length > 0) {
      rawText = ocrResult.ParsedResults[0].ParsedText;
    }

    // Ekstraksi sederhana (Bisa disesuaikan nanti)
    const currentDate = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toTimeString().split(' ')[0].substring(0, 5);

    // 4. Simpan ke Database Tabel receipts
    const { error: dbError } = await supabase.from('receipts').insert([
      {
        group_id: groupName,
        image_url: imageUrl,
        transaction_date: currentDate,
        transaction_time: currentTime,
        description: 'Nota Belanja Otomatis',
        amount: 0, // Placeholder nominal awal
        raw_text: rawText
      }
    ]);

    if (dbError) throw new Error('Gagal simpan ke Database: ' + dbError.message);

    return res.status(200).json({ success: true, message: 'Nota berhasil diproses!' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
