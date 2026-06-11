#!/bin/bash

# setup-staging.sh
# Automates the setup of the netar.is staging environment.
# Run this from the project root.

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Setting up Netaris Staging Environment...${NC}"

# 1. Update Nginx configuration
echo -e "${YELLOW}[1/3] Updating Nginx configuration...${NC}"
if [ -f "nginx-staging.conf" ]; then
    sudo cp nginx-staging.conf /etc/nginx/sites-available/netaris-staging.conf
    sudo ln -sf /etc/nginx/sites-available/netaris-staging.conf /etc/nginx/sites-enabled/
    echo -e "${GREEN}Staging Nginx config copied and enabled.${NC}"
else
    echo -e "${RED}Error: nginx-staging.conf not found!${NC}"
    exit 1
fi

# 2. Sync environment files
echo -e "${YELLOW}[2/3] Setting up environment variables...${NC}"
# Note: We use .env.staging as the primary config for the backend in staging mode
# The client will use its own .env.staging when built with --mode staging

if [ -f ".env.staging" ]; then
    # We don't overwrite .env, but we ensure the staging variables are available
    echo -e "${GREEN}Global .env.staging found.${NC}"
else
    echo -e "${YELLOW}Warning: Global .env.staging not found.${NC}"
fi

if [ -f "client/.env.staging" ]; then
    echo -e "${GREEN}Client .env.staging found.${NC}"
else
    echo -e "${YELLOW}Warning: Client .env.staging not found.${NC}"
fi

# 3. Verify Nginx and Reload
echo -e "${YELLOW}[3/3] Verifying and reloading Nginx...${NC}"
if sudo nginx -t; then
    sudo systemctl reload nginx
    echo -e "${GREEN}Nginx reloaded successfully.${NC}"
else
    echo -e "${RED}Nginx configuration test failed! Please check manually.${NC}"
    exit 1
fi

echo -e "\n${GREEN}Staging environment setup complete!${NC}"
echo -e "To start the application in headless staging mode, run:"
echo -e "${YELLOW}npm run dev-staging-headless${NC}"
echo -e "\nOr individually:"
echo -e "${YELLOW}Backend:${NC} npm run dev-backend-staging"
echo -e "${YELLOW}Client:${NC}  npm run dev-client-staging"
