require('dotenv').config(); // Load env variables

const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Shopify and Google credentials
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STOREFRONT_ACCESS_TOKEN = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// Check if .env variables are present
if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STOREFRONT_ACCESS_TOKEN || !GOOGLE_CLIENT_ID) {
    console.error("❌ Missing one or more required environment variables. Please check your .env file.");
    process.exit(1);
}

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Relaxed security headers (dev only)
app.use((req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    next();
});

// Helper for clean API response
function handleApiResponse(response) {
    console.log('Response Status:', response.status);
    console.log('Response Headers:', response.headers);

    if (response.headers['content-type']?.includes('html')) {
        console.error('Received HTML instead of JSON. Body:', response.data);
        return { error: 'Expected JSON, received HTML. Likely a wrong endpoint or failed auth.' };
    }

    return response.data;
}

// Check if customer exists
async function findCustomerByEmail(email) {
    try {
        const response = await axios.get(`${SHOPIFY_STORE_URL}/admin/api/2023-10/customers/search.json?query=email:${email}`, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
        });

        const data = handleApiResponse(response);
        if (data.error) return null;
        return data.customers?.[0] || null;
    } catch (error) {
        console.error('❌ Error checking customer:', error.response?.data || error.message);
        return null;
    }
}

// Create a new Shopify customer
async function createCustomer(payload) {
    try {
        const response = await axios.post(`${SHOPIFY_STORE_URL}/admin/api/2023-10/customers.json`, {
            customer: {
                first_name: payload.given_name,
                last_name: payload.family_name,
                email: payload.email,
                verified_email: true,
                password: "Default@123",
                password_confirmation: "Default@123"
            }
        }, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
        });

        const data = handleApiResponse(response);
        if (data.error) return null;
        return data.customer;
    } catch (error) {
        console.error('❌ Error creating customer:', error.response?.data || error.message);
        return null;
    }
}

// Update an existing Shopify customer's password
async function updateCustomerPassword(customerId, newPassword) {
    try {
        const response = await axios.put(`${SHOPIFY_STORE_URL}/admin/api/2023-10/customers/${customerId}.json`, {
            customer: {
                id: customerId,
                password: newPassword,
                password_confirmation: newPassword
            }
        }, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
        });

        const data = handleApiResponse(response);
        if (data.error) return null;
        return data.customer;
    } catch (error) {
        console.error('❌ Error updating customer password:', error.response?.data || error.message);
        return null;
    }
}

// Generate access token (GraphQL)
async function createCustomerAccessToken(email) {
    try {
        const response = await axios.post(`${SHOPIFY_STORE_URL}/api/2024-04/graphql.json`, {
            query: `
                mutation customerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
                    customerAccessTokenCreate(input: $input) {
                        customerAccessToken {
                            accessToken
                            expiresAt
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `,
            variables: { input: { email, password: "12$@565mnbvfethiwpldkao" } }
        }, {
            headers: {
                'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        const data = handleApiResponse(response);
        if (data.error) return null;

        const tokenData = data.data.customerAccessTokenCreate;
        if (tokenData.userErrors.length) {
            console.error('❌ GraphQL user errors:', tokenData.userErrors);
            return null;
        }

        return tokenData.customerAccessToken.accessToken;
    } catch (error) {
        console.error('❌ Access token error:', error.response?.data || error.message);
        return null;
    }
}

// Google OAuth2 Login Endpoint
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;

    console.log("📨 Received Google token:", token);

    if (!token) {
        return res.status(400).json({ success: false, error: 'Token is required' });
    }

    try {
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        console.log('✅ Google login payload:', payload.email);

        let customer = await findCustomerByEmail(payload.email);
        if (!customer) {
            console.log('🆕 Creating new customer for:', payload.email);
            customer = await createCustomer(payload);
            if (!customer) {
                throw new Error('Failed to create customer in Shopify');
            }
        } else {
            console.log('👤 Existing customer found:', customer.id);
            const updatedCustomer = await updateCustomerPassword(customer.id, "Default@123");
            if (!updatedCustomer) {
                throw new Error('Failed to update customer password');
            }
            console.log('🔑 Customer password updated');
        }

        const customerToken = await createCustomerAccessToken(payload.email);
        if (!customerToken) {
            throw new Error('Failed to generate customer access token');
        }

        const redirectUrl = `${SHOPIFY_STORE_URL}/account`;
        console.log('🔁 Redirecting user to:', redirectUrl);

        res.json({
            success: true,
            token: customerToken,
            redirectUrl,
            customer: {
                id: customer.id,
                email: customer.email,
                firstName: customer.first_name,
                lastName: customer.last_name
            }
        });

    } catch (error) {
        console.error('❌ Google Auth error:', error);
        res.status(500).json({
            success: false,
            error: 'Authentication failed',
            details: error.message,
            stack: error.stack // Optional: remove this in production
        });
    }
});

// Catch-all 404
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
