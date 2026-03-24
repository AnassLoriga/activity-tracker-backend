# 1. Utiliser une image Node.js légère
FROM node:18-alpine

# 2. Définir le répertoire de travail dans le conteneur
WORKDIR /app

# 3. Copier les fichiers de définition des dépendances
COPY package*.json ./

# 4. Installer les dépendances
RUN npm install

# 5. Copier tout le reste du code de l'application
COPY . .

# 6. Exposer le port utilisé par l'API (défini dans server.js)
EXPOSE 3000

# 7. Commande pour démarrer le serveur
CMD ["node", "server.js"]