const io = require('socket.io-client');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Configuration
const proxyUrl = 'http://131.153.187.5:50689'; // Replace with your proxy server
const targetUrl = 'https://bonziworld.org'; // Replace with your imaginary website

// Create a function to connect to Socket.IO through a proxy
function connectBot() {
    // Create an agent for the proxy
    const agent = new HttpsProxyAgent(proxyUrl);

    // Connect to the Socket.IO server
    const socket = io(targetUrl, {
        agent: agent, // Use the proxy agent
        transports: ['websocket'], // Use websocket transport
    });

    socket.emit("login",{name: "test"})

    socket.on('connect', () => {
        console.log('Connected to the Socket.IO server through proxy!');
        // You can emit or listen for events here
    });

    socket.on('talk', (data) => {
        console.log('Message received:', JSON.stringify(data));
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from the server');
    });
}


connectBot();
