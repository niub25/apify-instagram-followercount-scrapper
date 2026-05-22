# Lightweight Node.js image — no browser needed, pure HTTP scraping
FROM apify/actor-node:20

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional

COPY . ./

CMD npm start --silent
