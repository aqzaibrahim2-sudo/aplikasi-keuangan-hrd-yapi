export default function handler(req, res) {
  // Hanya izinkan metode HTTP POST
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      message: 'Method Not Allowed' 
    });
  }

  try {
    const { pin } = req.body;

    // Ambil PIN dari Environment Variable Vercel (DASHBOARD_PIN)
    // Jika variabel belum diset di Vercel, fallback default menggunakan '123456'
    const CORRECT_PIN = process.env.DASHBOARD_PIN || '123456';

    // Pengecekan validasi PIN
    if (pin === CORRECT_PIN) {
      return res.status(200).json({ 
        success: true, 
        message: 'Akses diterima, PIN valid.' 
      });
    } else {
      return res.status(401).json({ 
        success: false, 
        message: 'PIN salah, silakan coba lagi.' 
      });
    }
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      message: 'Terjadi kesalahan pada server.' 
    });
  }
}
