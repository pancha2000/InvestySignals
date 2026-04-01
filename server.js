const express = require('express');
const app = express();
const PORT = 2000;

// මුල් පිටුව (Home Page)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="si">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>InvestySignals | Crypto Trading</title>
            <style>
                body {
                    font-family: 'Arial', sans-serif;
                    background-color: #0f172a;
                    color: #ffffff;
                    text-align: center;
                    padding: 50px 20px;
                    margin: 0;
                }
                h1 {
                    color: #3b82f6;
                    font-size: 2.5em;
                }
                p {
                    font-size: 1.2em;
                    color: #94a3b8;
                    line-height: 1.6;
                }
                .container {
                    max-width: 600px;
                    margin: 0 auto;
                    padding: 20px;
                    background-color: #1e293b;
                    border-radius: 10px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 InvestySignals</h1>
                <p>ඔබේ විශ්වාසවන්ත Crypto Trading සහකරු.</p>
                <p>අපගේ නවතම වෙබ් අඩවිය ඉතා ඉක්මනින් ඔබ වෙත පැමිණෙනවා. රැඳී සිටින්න!</p>
            </div>
        </body>
        </html>
    `);
});

// සර්වර් එක start කිරීම
app.listen(PORT, () => {
    console.log("✅ InvestySignals Server is running on port 2000");
});
