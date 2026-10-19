export default async function handler(req, res) {
  // Hanya izinkan method POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pin } = req.body;
  const serverPin = process.env.DASHBOARD_PIN; // Mengambil PIN dari Environment Variable Vercel

  if (!serverPin) {
    return res.status(500).json({ success: false, message: 'Server PIN belum dikonfigurasi di Vercel.' });
  }

  if (pin === serverPin) {
    return res.status(200).json({ success: true });
  } else {
    return res.status(401).json({ success: false, message: 'PIN salah' });
  }
}
