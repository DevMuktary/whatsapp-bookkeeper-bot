import Brevo from '@getbrevo/brevo';

// --- Initialize Brevo API client ---
const defaultClient = Brevo.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new Brevo.TransactionalEmailsApi();

const SENDER_EMAIL = 'no-reply@fynaxtech.com';
const SENDER_NAME = 'Fynax Bookkeeper';

/**
 * Sends a beautiful HTML email with an OTP for verification.
 */
export async function sendOtpEmail(userEmail, otp, businessName) {
    console.log("--- DEBUG: ENTERING 'sendOtpEmail' function. ---");

    if (!process.env.BREVO_API_KEY) {
        console.error("--- DEBUG: FAILED - Brevo API key is MISSING in environment variables. ---");
        return false;
    }

    console.log("--- DEBUG: Brevo API key found. Preparing to send email. ---");

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f7fafc; }
            .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
            .header { background-color: #001232; color: #ffffff; padding: 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; color: #ffffff !important; }
            .content { padding: 30px; color: #2d3748; line-height: 1.7; }
            .content p { margin-bottom: 20px; }
            .otp-code { background-color: #f7fafc; border: 1px dashed #e2e8f0; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0; }
            .otp-code h2 { font-size: 36px; margin: 0; color: #0052cc; letter-spacing: 4px; }
            .footer { background-color: #f7fafc; padding: 20px; text-align: center; font-size: 12px; color: #5a677b; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Fynax Bookkeeper</h1>
            </div>
            <div class="content">
                <p>Hello,</p>
                <p>Here is your one-time verification code for your business, <strong>${businessName}</strong>. Please send this code back to the Fynax Bookkeeper on WhatsApp to verify your email address.</p>
                <div class="otp-code">
                    <h2>${otp}</h2>
                </div>
                <p>If you did not request this code, you can safely ignore this email.</p>
                <p>Thank you,<br>The Fynax Team</p>
            </div>
            <div class="footer">
                &copy; ${new Date().getFullYear()} Fynax Technology Concepts. All rights reserved.
            </div>
        </div>
    </body>
    </html>
    `;

    try {
        console.log("--- DEBUG: Calling Brevo's 'sendTransacEmail' function... ---");
        
        const response = await apiInstance.sendTransacEmail({
            sender: { email: SENDER_EMAIL, name: SENDER_NAME },
            to: [{ email: userEmail }],
            subject: `Your Fynax Bookkeeper Verification Code is ${otp}`,
            htmlContent: htmlContent,
        });

        console.log("--- DEBUG: Brevo API call FINISHED WITHOUT CRASHING. ---");
        console.log("--- DEBUG: FULL BREVO RESPONSE: ---");
        console.log(JSON.stringify(response, null, 2));
        
        console.log("--- DEBUG: Returning 'true' from notificationService. ---");
        return true;

    } catch (error) {
        console.error("--- DEBUG: Brevo API call FAILED with an error. ---");
        console.error("--- DEBUG: FULL BREVO ERROR OBJECT: ---");
        console.error(JSON.stringify(error, null, 2));
        
        console.error("--- DEBUG: Returning 'false' from notificationService. ---");
        return false;
    }
}

