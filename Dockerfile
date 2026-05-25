FROM nginx:alpine
# Copy static files to Nginx default directory
COPY . /usr/share/nginx/html
# Expose port 80
EXPOSE 80
# Run Nginx
CMD ["nginx", "-g", "daemon off;"]
