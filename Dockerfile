# Use Playwright-enabled Apify base image (includes Chromium)
FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --only=prod --no-optional

COPY . ./

CMD npm start --silent
