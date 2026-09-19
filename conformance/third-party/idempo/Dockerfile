FROM golang:1.26.8-alpine3.24

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY main.go ./
RUN go build -o /fixture .

EXPOSE 3000
CMD ["/fixture"]
