require('dotenv').config();
const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const preferenceClient = new Preference(mpClient);
const paymentClient = new Payment(mpClient);

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Listar produtos
app.get('/api/products', async (req, res) => {
    try {
        const products = await prisma.product.findMany();
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar produtos' });
    }
});

// Cadastrar produto
app.post('/api/products', async (req, res) => {
    const { name, description, price, imageUrl, downloadLink } = req.body;
    try {
        const product = await prisma.product.create({
            data: { name, description, price: parseFloat(price), imageUrl, downloadLink }
        });
        res.status(201).json(product);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao cadastrar produto' });
    }
});

// Criar preferência de checkout (Carrinho)
app.post('/api/checkout', async (req, res) => {
    const { items } = req.body; // Array de { id, quantity }

    try {
        const productIds = items.map(i => i.id);
        const dbProducts = await prisma.product.findMany({
            where: { id: { in: productIds } }
        });

        // Cria pedido pendente no banco
        const order = await prisma.order.create({
            data: {
                status: 'pending',
                items: {
                    create: dbProducts.map(p => ({ productId: p.id }))
                }
            }
        });

        // Monta os itens para o Mercado Pago
        const mpItems = dbProducts.map(p => ({
            id: p.id,
            title: p.name,
            unit_price: p.price,
            quantity: 1,
            currency_id: 'BRL'
        }));

        const preference = await preferenceClient.create({
            body: {
                items: mpItems,
                external_reference: order.id,
                notification_url: process.env.WEBHOOK_URL,
                back_urls: {
                    success: process.env.SUCCESS_URL
                },
                auto_return: 'approved'
            }
        });

        res.json({ init_point: preference.init_point });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao processar checkout' });
    }
});

// Webhook do Mercado Pago
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const { type, data } = req.body;

    if (type === 'payment') {
        try {
            const payment = await paymentClient.get({ id: data.id });

            if (payment.status === 'approved') {
                const orderId = payment.external_reference;
                const customerEmail = payment.payer.email;

                const order = await prisma.order.findUnique({
                    where: { id: orderId },
                    include: { items: { include: { product: true } } }
                });

                if (order && order.status !== 'approved') {
                    // Atualiza status do pedido
                    await prisma.order.update({
                        where: { id: orderId },
                        data: { status: 'approved', paymentId: String(data.id), customerEmail }
                    });

                    // Monta a lista de links para o email
                    let linksHtml = '';
                    order.items.forEach(item => {
                        linksHtml += `<li><strong>${item.product.name}</strong>: <a href="${item.product.downloadLink}">Clique aqui para baixar</a></li>`;
                    });

                    await transporter.sendMail({
                        from: process.env.EMAIL_USER,
                        to: customerEmail,
                        subject: 'Seus PDFs comprados chegaram!',
                        html: `
                            <h3>Obrigado pela sua compra!</h3>
                            <p>Seu pagamento foi confirmado. Abaixo estão os links de acesso aos seus arquivos:</p>
                            <ul>${linksHtml}</ul>
                        `
                    });
                }
            }
        } catch (error) {
            console.error('Erro no processamento do webhook:', error);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));