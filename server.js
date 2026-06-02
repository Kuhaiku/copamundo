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

// Middleware de Segurança do Painel Admin
const adminAuth = (req, res, next) => {
    const pass = req.headers['x-admin-password'];
    if (pass && pass === process.env.ADMIN_PASS) {
        return next();
    }
    res.status(401).json({ error: 'Acesso Negado. Senha incorreta.' });
};

// ---------------------------------------------------
// ROTAS DE PRODUTOS
// ---------------------------------------------------
app.get('/api/products', async (req, res) => {
    try {
        const products = await prisma.product.findMany();
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar produtos' });
    }
});

// Protegido com senha
app.post('/api/products', adminAuth, async (req, res) => {
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

// Protegido com senha
app.put('/api/products/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    const { name, description, price, imageUrl, downloadLink } = req.body;
    try {
        const product = await prisma.product.update({
            where: { id },
            data: { name, description, price: parseFloat(price), imageUrl, downloadLink }
        });
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar produto' });
    }
});

// Protegido com senha
app.delete('/api/products/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.orderItem.deleteMany({ where: { productId: id } });
        await prisma.product.delete({ where: { id } });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: 'Erro ao deletar produto' });
    }
});

// ---------------------------------------------------
// ROTA DO RELATÓRIO DE VENDAS
// ---------------------------------------------------
app.get('/api/orders', adminAuth, async (req, res) => {
    try {
        const orders = await prisma.order.findMany({
            where: { status: 'approved' },
            orderBy: { createdAt: 'desc' }, // Mais recentes primeiro
            include: {
                items: { include: { product: true } }
            }
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar relatório de vendas' });
    }
});

// ---------------------------------------------------
// ROTAS DE CHECKOUT E WEBHOOK
// ---------------------------------------------------
app.post('/api/checkout', async (req, res) => {
    const { items, email } = req.body; 
    try {
        const productIds = items.map(i => i.id);
        const dbProducts = await prisma.product.findMany({
            where: { id: { in: productIds } }
        });

        const order = await prisma.order.create({
            data: {
                status: 'pending',
                customerEmail: email,
                items: { create: dbProducts.map(p => ({ productId: p.id })) }
            }
        });

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
                back_urls: { success: process.env.SUCCESS_URL },
                auto_return: 'approved'
            }
        });

        res.json({ init_point: preference.init_point });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erro ao processar checkout' });
    }
});

app.get('/webhook', (req, res) => res.sendStatus(200));

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const { type, data } = req.body;

    if (type === 'payment') {
        try {
            const payment = await paymentClient.get({ id: data.id });

            if (payment.status === 'approved') {
                const orderId = payment.external_reference;
                
                const order = await prisma.order.findUnique({
                    where: { id: orderId },
                    include: { items: { include: { product: true } } }
                });

                if (order && order.status !== 'approved') {
                    const emailGarantia = order.customerEmail;
                    const emailMP = payment.payer?.email || payment.additional_info?.payer?.email || '';

                    const destinatarios = new Set();
                    if (emailGarantia && emailGarantia.includes('@')) destinatarios.add(emailGarantia);
                    if (emailMP && emailMP.includes('@')) destinatarios.add(emailMP);

                    const listaEmails = Array.from(destinatarios).join(', ');

                    await prisma.order.update({
                        where: { id: orderId },
                        data: { 
                            status: 'approved', 
                            paymentId: String(data.id), 
                            customerEmail: listaEmails || 'SEM_EMAIL' 
                        }
                    });

                    if (listaEmails.length === 0) return;

                    let linksHtml = '';
                    order.items.forEach(item => {
                        linksHtml += `<li><strong>${item.product.name}</strong>: <a href="${item.product.downloadLink}">Clique aqui para baixar</a></li>`;
                    });

                    await transporter.sendMail({
                        from: process.env.EMAIL_USER,
                        to: listaEmails, 
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