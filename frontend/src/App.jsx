import { useState } from 'react';
import axios from 'axios';

function App() {
  const [image, setImage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setImage(file);
      setPreview(URL.createObjectURL(file));
      setDescription('');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!image) return;

    setLoading(true);
    const formData = new FormData();
    formData.append('image', image);

    try {
      const res = await axios.post('http://localhost:5000/api/summarize', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      
      setDescription(res.data.description);
    } catch (err) {
      console.error(err);
      alert('Error: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#0f172a',        // Deep professional dark blue
      margin: 0,
      padding: '40px 20px',
      fontFamily: 'Segoe UI, Arial, sans-serif',
      color: '#e2e8f0'
    }}>
      
      <div style={{
        maxWidth: '820px',
        margin: '0 auto',
        backgroundColor: '#1e2937',
        padding: '40px',
        borderRadius: '16px',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
        border: '1px solid #334155'
      }}>
        
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <h1 style={{ 
            fontSize: '2.5rem', 
            margin: '0 0 8px 0',
            color: '#60a5fa'
          }}>
            🎭 Caricature Summarizer
          </h1>
          <p style={{ 
            color: '#94a3b8', 
            fontSize: '1.1rem',
            margin: 0 
          }}>
            AI-Powered Image Analysis
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ marginTop: '20px' }}>
          <div style={{ 
            marginBottom: '25px',
            textAlign: 'center'
          }}>
            <input 
              type="file" 
              accept="image/*" 
              onChange={handleImageChange}
              style={{ 
                display: 'block', 
                margin: '0 auto',
                color: '#e2e8f0'
              }}
            />
          </div>
          
          {preview && (
            <div style={{ margin: '30px 0', textAlign: 'center' }}>
              <h3 style={{ color: '#cbd5e1', marginBottom: '12px' }}>Image Preview</h3>
              <img 
                src={preview} 
                alt="preview" 
                style={{ 
                  maxWidth: '100%', 
                  maxHeight: '420px',
                  borderRadius: '12px',
                  border: '1px solid #475569',
                  boxShadow: '0 10px 20px rgba(0,0,0,0.2)'
                }} 
              />
            </div>
          )}

          <button 
            type="submit" 
            disabled={loading || !image}
            style={{
              width: '100%',
              padding: '16px',
              fontSize: '1.1rem',
              backgroundColor: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '10px',
              cursor: 'pointer',
              fontWeight: '600',
              marginTop: '10px'
            }}
          >
            {loading ? 'Analyzing with Gemini...' : 'Get AI Description'}
          </button>
        </form>

        {description && (
          <div style={{ 
            marginTop: '40px', 
            backgroundColor: '#0f172a', 
            padding: '28px', 
            borderRadius: '12px',
            border: '1px solid #334155',
            textAlign: 'left'
          }}>
            <h3 style={{ color: '#60a5fa', marginBottom: '16px' }}>
              ✨ Gemini Analysis
            </h3>
            <p style={{ 
              lineHeight: '1.7',
              color: '#e2e8f0',
              whiteSpace: 'pre-wrap'
            }}>
              {description}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;