// Command fiber mounts the anyonce conformance fixture contract
// (conformance/README.md) behind github.com/gofiber/fiber/v3/middleware/idempotency
// at fiber v3.5.0. Used only by conformance/third-party/compose.yml; this is
// not a workspace package. KeyHeader and KeyHeaderValidate are overridden
// from their defaults; see conformance/third-party/README.md (Q53).
package main

import (
	"bytes"
	"log"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/idempotency"
)

var count atomic.Int64

func main() {
	app := fiber.New()

	// Control endpoint: mounted OUTSIDE the idempotency layer.
	app.Post("/reset", func(c fiber.Ctx) error {
		count.Store(0)
		return c.SendStatus(fiber.StatusNoContent)
	})

	app.Use(idempotency.New(idempotency.Config{
		Lifetime:  2 * time.Second,
		KeyHeader: "Idempotency-Key",
		KeyHeaderValidate: func(k string) error {
			return nil
		},
	}))

	app.Get("/counter", func(c fiber.Ctx) error {
		return c.JSON(fiber.Map{"count": int(count.Load())})
	})

	app.Post("/echo", func(c fiber.Ctx) error {
		count.Add(1)
		ct := c.Get("Content-Type")
		if ct == "" {
			ct = "application/octet-stream"
		}
		c.Set("Content-Type", ct)
		c.Status(fiber.StatusCreated)
		return c.Send(c.Body())
	})

	app.Post("/status/:code", func(c fiber.Ctx) error {
		code, err := strconv.Atoi(c.Params("code"))
		if err != nil || code < 200 || code > 599 {
			return c.Status(fiber.StatusBadRequest).SendString("invalid status code")
		}
		count.Add(1)
		c.Set("Content-Type", "text/plain")
		return c.Status(code).SendString("status:" + strconv.Itoa(code))
	})

	app.Post("/slow", func(c fiber.Ctx) error {
		count.Add(1)
		ms, err := strconv.Atoi(c.Query("ms"))
		if err != nil || ms < 0 {
			ms = 0
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		c.Set("Content-Type", "text/plain")
		return c.SendString("slept:" + strconv.Itoa(ms))
	})

	app.Post("/large", func(c fiber.Ctx) error {
		count.Add(1)
		n, err := strconv.Atoi(c.Query("bytes"))
		if err != nil || n < 0 {
			n = 0
		}
		c.Set("Content-Type", "application/octet-stream")
		return c.Send(bytes.Repeat([]byte{'x'}, n))
	})

	log.Println("fiber fixture listening on :3000")
	if err := app.Listen(":3000"); err != nil {
		log.Fatal(err)
	}
}
